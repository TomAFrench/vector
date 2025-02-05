import { Vector } from "@connext/vector-protocol";
import {
  ChainAddresses,
  IChannelSigner,
  ILockService,
  IMessagingService,
  IVectorProtocol,
  Result,
  EngineParams,
  OutboundChannelUpdateError,
  ChannelRpcMethodsResponsesMap,
  IVectorEngine,
  EngineEventMap,
  IEngineStore,
  EngineEvent,
  EngineEvents,
  ChannelRpcMethod,
  IVectorChainService,
  WITHDRAWAL_RECONCILED_EVENT,
  ChannelRpcMethods,
  IExternalValidation,
  AUTODEPLOY_CHAIN_IDS,
  FullChannelState,
  EngineError,
  UpdateType,
  InboundChannelUpdateError,
} from "@connext/vector-types";
import {
  generateMerkleTreeData,
  validateChannelUpdateSignatures,
  getSignerAddressFromPublicIdentifier,
} from "@connext/vector-utils";
import pino from "pino";
import Ajv from "ajv";
import { Evt } from "evt";

import { version } from "../package.json";

import { InvalidTransferType } from "./errors";
import {
  convertConditionalTransferParams,
  convertResolveConditionParams,
  convertWithdrawParams,
} from "./paramConverter";
import { setupEngineListeners } from "./listeners";
import { getEngineEvtContainer } from "./utils";
import { sendIsAlive } from "./isAlive";

export const ajv = new Ajv();

export type EngineEvtContainer = { [K in keyof EngineEventMap]: Evt<EngineEventMap[K]> };

export class VectorEngine implements IVectorEngine {
  // Setup event container to emit events from vector
  private readonly evts: EngineEvtContainer = getEngineEvtContainer();

  private readonly restoreLocks: { [channelAddress: string]: string } = {};

  private constructor(
    private readonly signer: IChannelSigner,
    private readonly messaging: IMessagingService,
    private readonly store: IEngineStore,
    private readonly vector: IVectorProtocol,
    private readonly chainService: IVectorChainService,
    private readonly chainAddresses: ChainAddresses,
    private readonly lockService: ILockService,
    private readonly logger: pino.BaseLogger,
  ) {}

  static async connect(
    messaging: IMessagingService,
    lock: ILockService,
    store: IEngineStore,
    signer: IChannelSigner,
    chainService: IVectorChainService,
    chainAddresses: ChainAddresses,
    logger: pino.BaseLogger,
    skipCheckIn: boolean,
    validationService?: IExternalValidation,
  ): Promise<VectorEngine> {
    const vector = await Vector.connect(
      messaging,
      lock,
      store,
      signer,
      chainService,
      logger.child({ module: "VectorProtocol" }),
      skipCheckIn,
      validationService,
    );
    const engine = new VectorEngine(
      signer,
      messaging,
      store,
      vector,
      chainService,
      chainAddresses,
      lock,
      logger.child({ module: "VectorEngine" }),
    );
    await engine.setupListener();
    logger.debug({}, "Setup engine listeners");
    if (!skipCheckIn) {
      sendIsAlive(engine.signer, engine.messaging, engine.store, engine.logger);
    } else {
      logger.warn("Skipping isAlive broadcast because of skipCheckIn config");
    }
    logger.info({ vector: vector.publicIdentifier }, "Vector Engine connected 🚀!");
    return engine;
  }

  get publicIdentifier(): string {
    return this.vector.publicIdentifier;
  }

  get signerAddress(): string {
    return this.vector.signerAddress;
  }

  // TODO: create injected validation that handles submitting transactions
  // IFF there was a fee involved. Should:
  // - check if fee > 0
  //    - yes && my withdrawal: make sure transaction hash is included in
  //      the meta (verify tx)

  private async setupListener(): Promise<void> {
    await setupEngineListeners(
      this.evts,
      this.chainService,
      this.vector,
      this.messaging,
      this.signer,
      this.store,
      this.chainAddresses,
      this.logger,
      this.setup.bind(this),
      this.acquireRestoreLocks.bind(this),
      this.releaseRestoreLocks.bind(this),
    );
  }

  private async acquireRestoreLocks(channel: FullChannelState): Promise<Result<void, EngineError>> {
    if (this.restoreLocks[channel.channelAddress]) {
      // Has already been released, return undefined
      return Result.ok(this.restoreLocks[channel.channelAddress]);
    }
    try {
      const isAlice = channel.alice === this.signer.address;
      const lockVal = await this.lockService.acquireLock(
        channel.channelAddress,
        isAlice,
        isAlice ? channel.bobIdentifier : channel.aliceIdentifier,
      );
      this.restoreLocks[channel.channelAddress] = lockVal;
      return Result.ok(undefined);
    } catch (e) {
      return Result.fail(
        new EngineError("Failed to acquire restore lock", channel.channelAddress, {
          publicIdentifier: this.signer.publicIdentifier,
        }),
      );
    }
  }

  private async releaseRestoreLocks(channel: FullChannelState): Promise<Result<void, EngineError>> {
    if (!this.restoreLocks[channel.channelAddress]) {
      // Has already been released, return undefined
      return Result.ok(undefined);
    }
    try {
      const isAlice = channel.alice === this.signer.address;
      await this.lockService.releaseLock(
        channel.channelAddress,
        this.restoreLocks[channel.channelAddress],
        isAlice,
        isAlice ? channel.bobIdentifier : channel.aliceIdentifier,
      );
      delete this.restoreLocks[channel.channelAddress];
      return Result.ok(undefined);
    } catch (e) {
      return Result.fail(
        new EngineError("Failed to release restore lock", channel.channelAddress, {
          publicIdentifier: this.signer.publicIdentifier,
        }),
      );
    }
  }

  private async getConfig(): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getConfig]>> {
    return Result.ok([{ index: 0, publicIdentifier: this.publicIdentifier, signerAddress: this.signerAddress }]);
  }

  private async getStatus(): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getStatus]>> {
    const chainIds = Object.keys(this.chainAddresses).map((chainId) => parseInt(chainId));
    const providerResponses = await Promise.all(chainIds.map((chainId) => this.chainService.getSyncing(chainId)));
    const providerSyncing = Object.fromEntries(
      chainIds.map((chainId, index) => {
        const res = providerResponses[index];
        let syncing:
          | string
          | boolean
          | { startingBlock: string; currentBlock: string; highestBlock: string }
          | undefined;
        if (res.isError) {
          syncing = res.getError()?.message;
        } else {
          syncing = res.getValue();
        }
        return [chainId, syncing];
      }),
    );
    return Result.ok({
      version,
      publicIdentifier: this.publicIdentifier,
      signerAddress: this.signerAddress,
      providerSyncing,
    });
  }

  private async getChannelState(
    params: EngineParams.GetChannelState,
  ): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelState],
      Error | OutboundChannelUpdateError
    >
  > {
    const validate = ajv.compile(EngineParams.GetChannelStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    try {
      const channel = await this.store.getChannelState(params.channelAddress);
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getTransferState(
    params: EngineParams.GetTransferState,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferState], Error>> {
    const validate = ajv.compile(EngineParams.GetTransferStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    try {
      const transfer = await this.store.getTransferState(params.transferId);
      return Result.ok(transfer);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getActiveTransfers(
    params: EngineParams.GetActiveTransfers,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getActiveTransfers], Error>> {
    const validate = ajv.compile(EngineParams.GetActiveTransfersSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    try {
      const transfers = await this.store.getActiveTransfers(params.channelAddress);
      return Result.ok(transfers);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getTransferStateByRoutingId(
    params: EngineParams.GetTransferStateByRoutingId,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferStateByRoutingId], Error>> {
    const validate = ajv.compile(EngineParams.GetTransferStateByRoutingIdSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    try {
      const transfer = await this.store.getTransferByRoutingId(params.channelAddress, params.routingId);
      return Result.ok(transfer);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getTransferStatesByRoutingId(
    params: EngineParams.GetTransferStatesByRoutingId,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getTransferStatesByRoutingId], Error>> {
    const validate = ajv.compile(EngineParams.GetTransferStatesByRoutingIdSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    try {
      const transfers = await this.store.getTransfersByRoutingId(params.routingId);
      return Result.ok(transfers);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getChannelStateByParticipants(
    params: EngineParams.GetChannelStateByParticipants,
  ): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelStateByParticipants],
      Error | OutboundChannelUpdateError
    >
  > {
    const validate = ajv.compile(EngineParams.GetChannelStateByParticipantsSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    try {
      const channel = await this.store.getChannelStateByParticipants(params.alice, params.bob, params.chainId);
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getChannelStates(): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getChannelStates],
      Error | OutboundChannelUpdateError
    >
  > {
    try {
      const channel = await this.store.getChannelStates();
      return Result.ok(channel);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async getRegisteredTransfers(
    params: EngineParams.GetRegisteredTransfers,
  ): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_getRegisteredTransfers],
      Error | OutboundChannelUpdateError
    >
  > {
    const validate = ajv.compile(EngineParams.GetRegisteredTransfersSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    const { chainId } = params;
    const result = await this.chainService.getRegisteredTransfers(
      this.chainAddresses[chainId].transferRegistryAddress,
      chainId,
    );
    return result;
  }

  private async setup(
    params: EngineParams.Setup,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_setup], OutboundChannelUpdateError | Error>
  > {
    const validate = ajv.compile(EngineParams.SetupSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    const chainProviders = this.chainService.getChainProviders();
    if (chainProviders.isError) {
      return Result.fail(chainProviders.getError()!);
    }

    const setupRes = await this.vector.setup({
      counterpartyIdentifier: params.counterpartyIdentifier,
      timeout: params.timeout,
      networkContext: {
        channelFactoryAddress: this.chainAddresses[params.chainId].channelFactoryAddress,
        transferRegistryAddress: this.chainAddresses[params.chainId].transferRegistryAddress,
        chainId: params.chainId,
        providerUrl: chainProviders.getValue()[params.chainId],
      },
      meta: params.meta,
    });

    if (setupRes.isError) {
      return setupRes;
    }

    const channel = setupRes.getValue();
    if (this.signerAddress === channel.bob) {
      return setupRes;
    }

    // If it is alice && chain id is in autodeployable chains, deploy contract
    if (!AUTODEPLOY_CHAIN_IDS.includes(channel.networkContext.chainId)) {
      return setupRes;
    }

    this.logger.info(
      { chainId: channel.networkContext.chainId, channel: channel.channelAddress },
      "Deploying channel multisig",
    );
    const deployRes = await this.chainService.sendDeployChannelTx(channel);
    if (deployRes.isError) {
      const err = deployRes.getError();
      this.logger.error(
        {
          ...(err?.context ?? {}),
          chainId: channel.networkContext.chainId,
          channel: channel.channelAddress,
          error: deployRes.getError()!.message,
        },
        "Failed to deploy channel multisig",
      );
      return setupRes;
    }
    const tx = deployRes.getValue();
    this.logger.info({ chainId: channel.networkContext.chainId, hash: tx.hash }, "Deploy tx broadcast");
    await tx.wait();
    this.logger.debug({ chainId: channel.networkContext.chainId, hash: tx.hash }, "Deploy tx mined");
    return setupRes;
  }

  private async requestSetup(
    params: EngineParams.Setup,
  ): Promise<Result<{ channelAddress: string }, OutboundChannelUpdateError | Error>> {
    const validate = ajv.compile(EngineParams.SetupSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    return this.messaging.sendSetupMessage(Result.ok(params), params.counterpartyIdentifier, this.publicIdentifier);
  }

  private async deposit(
    params: EngineParams.Deposit,
  ): Promise<
    Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_deposit], OutboundChannelUpdateError | Error>
  > {
    const validate = ajv.compile(EngineParams.DepositSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    // NOTE: There is a race-condition for deposits because the onchain process
    // is out-of-band of the protocol. For instance:
    // 1. Alice deposits 5 onchain
    // 2a. Alice sends single-signed update where she has reconciled the 5
    // 2b. Bob deposits 3 onchain
    // 3. Bob receives Alice's signature, and attempts to reconcile on their
    //    own. Bob reconciles 8 and fails to recover Alice's signature properly
    //    leaving all 8 out of the channel.

    // There is no way to eliminate this race condition, so instead just retry
    // depositing if a signature validation error is detected.
    let depositRes = await this.vector.deposit(params);
    let count = 1;
    for (const _ of Array(3).fill(0)) {
      // If its not an error, do not retry
      if (!depositRes.isError) {
        break;
      }
      const error = depositRes.getError()!;
      // IFF deposit fails because you or the counterparty fails to recover
      // signatures, retry
      const recoveryFailed =
        error.message === OutboundChannelUpdateError.reasons.BadSignatures ||
        error.context?.counterpartyError === InboundChannelUpdateError.reasons.BadSignatures;

      if (!recoveryFailed) {
        break;
      }
      this.logger.warn({ attempt: count, error: depositRes.getError()?.message }, "Retrying deposit reconciliation");
      depositRes = await this.vector.deposit(params);
      count++;
    }

    return depositRes;
  }

  private async requestCollateral(
    params: EngineParams.RequestCollateral,
  ): Promise<Result<undefined, OutboundChannelUpdateError | Error>> {
    const validate = ajv.compile(EngineParams.RequestCollateralSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params as any),
      );
    }

    const request = await this.messaging.sendRequestCollateralMessage(
      Result.ok(params),
      this.publicIdentifier === channel.aliceIdentifier ? channel.bobIdentifier : channel.aliceIdentifier,
      this.publicIdentifier,
    );
    return request;
  }

  private async createTransfer(
    params: EngineParams.ConditionalTransfer,
  ): Promise<
    Result<
      ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_createTransfer],
      InvalidTransferType | OutboundChannelUpdateError
    >
  > {
    const validate = ajv.compile(EngineParams.ConditionalTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params as any),
      );
    }

    // First, get translated `create` params using the passed in conditional transfer ones
    const createResult = await convertConditionalTransferParams(
      params,
      this.signer,
      channel!,
      this.chainAddresses,
      this.chainService,
    );
    if (createResult.isError) {
      return Result.fail(createResult.getError()!);
    }
    const createParams = createResult.getValue();
    const protocolRes = await this.vector.create(createParams);
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    return Result.ok(res);
  }

  private async resolveTransfer(
    params: EngineParams.ResolveTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_resolveTransfer], Error>> {
    const validate = ajv.compile(EngineParams.ResolveTransferSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    const transferRes = await this.getTransferState({ transferId: params.transferId });
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.TransferNotFound, params as any),
      );
    }

    // First, get translated `create` params using the passed in conditional transfer ones
    const resolveResult = convertResolveConditionParams(params, transfer);
    if (resolveResult.isError) {
      return Result.fail(resolveResult.getError()!);
    }
    const resolveParams = resolveResult.getValue();
    const protocolRes = await this.vector.resolve(resolveParams);
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    return Result.ok(res);
  }

  private async withdraw(
    params: EngineParams.Withdraw,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_withdraw], Error>> {
    const validate = ajv.compile(EngineParams.WithdrawSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    const channelRes = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channelRes.isError) {
      return Result.fail(channelRes.getError()!);
    }
    const channel = channelRes.getValue();
    if (!channel) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params as any),
      );
    }

    // First, get translated `create` params from withdraw
    const createResult = await convertWithdrawParams(
      params,
      this.signer,
      channel,
      this.chainAddresses,
      this.chainService,
    );
    if (createResult.isError) {
      return Result.fail(createResult.getError()!);
    }
    const createParams = createResult.getValue();
    const protocolRes = await this.vector.create(createParams);
    if (protocolRes.isError) {
      return Result.fail(protocolRes.getError()!);
    }
    const res = protocolRes.getValue();
    const transferId = res.latestUpdate.details.transferId;
    this.logger.info({ channelAddress: params.channelAddress, transferId }, "Withdraw transfer created");

    let transactionHash: string | undefined = undefined;
    const timeout = 90_000;
    try {
      const event = await this.evts[WITHDRAWAL_RECONCILED_EVENT].attachOnce(
        timeout,
        (data) => data.channelAddress === params.channelAddress && data.transferId === transferId,
      );
      transactionHash = event.transactionHash;
    } catch (e) {
      this.logger.warn({ channelAddress: params.channelAddress, transferId, timeout }, "Withdraw tx not submitted");
    }

    return Result.ok({ channel: res, transactionHash });
  }

  private async decrypt(encrypted: string): Promise<Result<string, Error>> {
    try {
      const res = await this.signer.decrypt(encrypted);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async signUtilityMessage(params: EngineParams.SignUtilityMessage): Promise<Result<string, Error>> {
    const validate = ajv.compile(EngineParams.SignUtilityMessageSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    try {
      const sig = await this.signer.signUtilityMessage(params.message);
      return Result.ok(sig);
    } catch (e) {
      return Result.fail(e);
    }
  }

  private async sendIsAlive(params: EngineParams.SendIsAlive): Promise<Result<{ channelAddress: string }, Error>> {
    const validate = ajv.compile(EngineParams.SendIsAliveSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }
    try {
      const channel = await this.store.getChannelState(params.channelAddress);
      if (!channel) {
        return Result.fail(new EngineError("Channel not found", params.channelAddress));
      }
      const counterparty = this.signer.address === channel.alice ? channel.bobIdentifier : channel.aliceIdentifier;
      return this.messaging.sendIsAliveMessage(Result.ok(params), counterparty, this.signer.publicIdentifier);
    } catch (e) {
      return Result.fail(new EngineError(e.message, params.channelAddress));
    }
  }

  // RESTORE STATE
  // NOTE: MUST be under protocol lock
  private async restoreState(
    params: EngineParams.RestoreState,
  ): Promise<Result<ChannelRpcMethodsResponsesMap["chan_restoreState"], Error>> {
    const method = "restoreState";
    const validate = ajv.compile(EngineParams.RestoreStateSchema);
    const valid = validate(params);
    if (!valid) {
      return Result.fail(new Error(validate.errors?.map((err) => err.message).join(",")));
    }

    // Send message to counterparty, they will grab lock and
    // return information under lock, initiator will update channel,
    // then send confirmation message to counterparty, who will release the lock
    const { chainId, counterpartyIdentifier } = params;
    const restoreDataRes = await this.messaging.sendRestoreStateMessage(
      Result.ok({ chainId }),
      counterpartyIdentifier,
      this.signer.publicIdentifier,
    );
    if (restoreDataRes.isError) {
      return Result.fail(restoreDataRes.getError()!);
    }

    const { channel, activeTransfers } = restoreDataRes.getValue() ?? ({} as any);

    // Here you are under lock, verify things about channel
    // Create helper to send message allowing a release lock
    const sendResponseToCounterparty = async (error?: string, context: any = {}) => {
      if (!error) {
        const res = await this.messaging.sendRestoreStateMessage(
          Result.ok({
            channelAddress: channel.channelAddress,
          }),
          counterpartyIdentifier,
          this.signer.publicIdentifier,
        );
        if (res.isError) {
          error = "Restore failed: unable to ack";
          context = { error: res.getError()!.message };
        } else {
          return Result.ok(channel);
        }
      }

      // handle error by returning it to counterparty && returning result
      const err = new EngineError(error as string, channel.channelAddress, {
        ...context,
        signer: this.signer.publicIdentifier,
        chainId,
        method,
        counterpartyIdentifier,
      });
      await this.messaging.sendRestoreStateMessage(
        Result.fail(err),
        counterpartyIdentifier,
        this.signer.publicIdentifier,
      );
      return Result.fail(err);
    };

    // Verify data exists
    if (!channel || !activeTransfers) {
      return sendResponseToCounterparty("Restore failed: no data for restore");
    }

    // Verify channel address is same as calculated
    const counterparty = getSignerAddressFromPublicIdentifier(counterpartyIdentifier);
    const calculated = await this.chainService.getChannelAddress(
      channel.alice === this.signer.address ? this.signer.address : counterparty,
      channel.bob === this.signer.address ? this.signer.address : counterparty,
      channel.networkContext.channelFactoryAddress,
      chainId,
    );
    if (calculated.isError) {
      return sendResponseToCounterparty("Restore failed: could not verify channelAddress", {
        error: calculated.getError()!.message,
        ...calculated.getError()!.context,
      });
    }
    if (calculated.getValue() !== channel.channelAddress) {
      return sendResponseToCounterparty("Restore failed: invalid channelAddress", {
        calculated: calculated.getValue(),
      });
    }

    // Verify signatures on latest update
    const sigRes = await validateChannelUpdateSignatures(
      channel,
      channel.latestUpdate.aliceSignature,
      channel.latestUpdate.bobSignature,
      "both",
    );
    if (sigRes.isError) {
      return sendResponseToCounterparty("Restore failed: invalid signatures", {
        calculated: calculated.getValue(),
        error: sigRes.getError()!.message,
      });
    }

    // Verify transfers match merkleRoot
    const { root } = generateMerkleTreeData(activeTransfers);
    if (root !== channel.merkleRoot) {
      return sendResponseToCounterparty("Restore failed: invalid merkleRoot", {
        calculated: root,
        merkleRoot: channel.merkleRoot,
        activeTransfers: activeTransfers.map((t) => t.transferId),
      });
    }

    // Verify nothing with a sync-able nonce exists in store
    const existing = await this.getChannelState({ channelAddress: channel.channelAddress });
    if (existing.isError) {
      return sendResponseToCounterparty("Restore failed: store.getChannelState faileds", {
        error: existing.getError()?.message,
      });
    }
    const nonce = existing.getValue()?.nonce ?? 0;
    const diff = channel.nonce - nonce;
    if (diff <= 1 && channel.latestUpdate.type !== UpdateType.setup) {
      return sendResponseToCounterparty("Restore failed: syncable state", {
        existing: nonce,
        toRestore: channel.nonce,
      });
    }

    // Save channel
    try {
      await this.store.saveChannelStateAndTransfers(channel, activeTransfers);
    } catch (e) {
      return sendResponseToCounterparty("Restore failed: could not save state", {
        error: e.message,
      });
    }

    // Respond by saying this was a success
    const returnVal = await sendResponseToCounterparty();

    // Post to evt
    this.evts[EngineEvents.RESTORE_STATE_EVENT].post({
      channelAddress: channel.channelAddress,
      aliceIdentifier: channel.aliceIdentifier,
      bobIdentifier: channel.bobIdentifier,
      chainId,
    });

    return returnVal;
  }

  // DISPUTE METHODS
  private async disputeChannel(
    params: EngineParams.DisputeChannel,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_dispute], Error>> {
    const channel = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channel.isError) {
      return Result.fail(channel.getError()!);
    }
    const state = channel.getValue();
    if (!state) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params as any),
      );
    }
    const disputeRes = await this.chainService.sendDisputeChannelTx(state);
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }

    return Result.ok({ transactionHash: disputeRes.getValue().hash });
  }

  private async defundChannel(
    params: EngineParams.DefundChannel,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_defund], Error>> {
    const channel = await this.getChannelState({ channelAddress: params.channelAddress });
    if (channel.isError) {
      return Result.fail(channel.getError()!);
    }
    const state = channel.getValue();
    if (!state) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.ChannelNotFound, params as any),
      );
    }
    if (!state.inDispute) {
      return Result.fail(new Error("Channel not in dispute"));
    }
    const disputeRes = await this.chainService.sendDefundChannelTx(state);
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }

    return Result.ok({ transactionHash: disputeRes.getValue().hash });
  }

  private async disputeTransfer(
    params: EngineParams.DisputeTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_disputeTransfer], Error>> {
    const transferRes = await this.getTransferState(params);
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.TransferNotFound, params as any),
      );
    }

    // Get active transfers
    const activeRes = await this.getActiveTransfers({ channelAddress: transfer.channelAddress });
    if (activeRes.isError) {
      return Result.fail(activeRes.getError()!);
    }
    const disputeRes = await this.chainService.sendDisputeTransferTx(transfer.transferId, activeRes.getValue());
    if (disputeRes.isError) {
      return Result.fail(disputeRes.getError()!);
    }
    return Result.ok({ transactionHash: disputeRes.getValue().hash });
  }

  private async defundTransfer(
    params: EngineParams.DefundTransfer,
  ): Promise<Result<ChannelRpcMethodsResponsesMap[typeof ChannelRpcMethods.chan_defundTransfer], Error>> {
    const transferRes = await this.getTransferState(params);
    if (transferRes.isError) {
      return Result.fail(transferRes.getError()!);
    }
    const transfer = transferRes.getValue();
    if (!transfer) {
      return Result.fail(
        new OutboundChannelUpdateError(OutboundChannelUpdateError.reasons.TransferNotFound, params as any),
      );
    }

    if (!transfer.inDispute) {
      return Result.fail(new Error("Transfer not in dispute"));
    }

    const defundRes = await this.chainService.sendDefundTransferTx(transfer);
    if (defundRes.isError) {
      return Result.fail(defundRes.getError()!);
    }
    return Result.ok({ transactionHash: defundRes.getValue().hash });
  }

  // JSON RPC interface -- this will accept:
  // - "chan_deposit"
  // - "chan_createTransfer"
  // - "chan_resolveTransfer"
  // - etc.
  public async request<T extends ChannelRpcMethod>(
    payload: EngineParams.RpcRequest,
  ): Promise<ChannelRpcMethodsResponsesMap[T]> {
    this.logger.debug({ payload, method: "request" }, "Method called");
    const validate = ajv.compile(EngineParams.RpcRequestSchema);
    const valid = validate(payload);
    if (!valid) {
      // dont use result type since this could go over the wire
      // TODO: how to represent errors over the wire?
      this.logger.error({ method: "request", payload, ...(validate.errors ?? {}) });
      throw new Error(validate.errors?.map((err) => err.message).join(","));
    }

    const methodName = payload.method.replace("chan_", "");
    if (typeof this[methodName] !== "function") {
      throw new Error(`Invalid method: ${methodName}`);
    }

    // every method must be a result type
    const res = await this[methodName](payload.params);
    if (res.isError) {
      throw res.getError();
    }
    return res.getValue();
  }

  ///////////////////////////////////
  // EVENT METHODS

  public on<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): void {
    this.evts[event].pipe(filter).attach(callback);
  }

  public once<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): void {
    this.evts[event].pipe(filter).attachOnce(callback);
  }

  public waitFor<T extends EngineEvent>(
    event: T,
    timeout: number,
    filter: (payload: EngineEventMap[T]) => boolean = () => true,
  ): Promise<EngineEventMap[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout);
  }

  public off<T extends EngineEvent>(event?: T): void {
    if (event) {
      this.evts[event].detach();
      return;
    }

    Object.keys(EngineEvents).forEach((k) => this.evts[k].detach());
  }
}
