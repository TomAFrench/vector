import { VectorChainService } from "@connext/vector-contracts";
import { VectorEngine } from "@connext/vector-engine";
import {
  ChainAddresses,
  ChainProviders,
  ChannelRpcMethods,
  CreateUpdateDetails,
  EngineEvent,
  EngineEventMap,
  IChannelSigner,
  INodeService,
  NodeError,
  OptionalPublicIdentifier,
  Result,
  NodeParams,
  NodeResponses,
  EngineParams,
  FullChannelState,
  TransferNames,
  EngineEvents,
} from "@connext/vector-types";
import { constructRpcRequest, getRandomBytes32, hydrateProviders, NatsMessagingService } from "@connext/vector-utils";
import { sha256 as soliditySha256 } from "@ethersproject/solidity";
import pino, { BaseLogger } from "pino";

import { BrowserStore } from "./services/store";
import { BrowserLockService } from "./services/lock";
import { DirectProvider, IframeChannelProvider, IRpcChannelProvider } from "./channelProvider";

export type BrowserNodeSignerConfig = {
  natsUrl?: string;
  authUrl?: string;
  messagingUrl?: string;
  logger?: BaseLogger;
  signer: IChannelSigner;
  chainProviders: ChainProviders;
  chainAddresses: ChainAddresses;
};

const CROSS_CHAIN_TRANSFER_STATES = {
  BEGIN: "BEGIN",
  START_DEPOSIT: "START_DEPOSIT",
  START_CREATE_TRANSFER: "START_CREATE_TRANSFER",
  WAIT_FOR_CREATE_TRANSFER: "WAIT_FOR_CREATE_TRANSFER",
  START_RESOLVE_TRANSFER: "START_RESOLVE_TRANSFER",
  WAIT_FOR_RESOLVE_TRANSFER: "WAIT_FOR_RESOLVE_TRANSFER",
  START_WITHDRAW: "START_WITHDRAW",
  SUCCESS: "SUCCESS",
};

export class BrowserNode implements INodeService {
  public channelProvider: IRpcChannelProvider | undefined;
  public publicIdentifier = "";
  public signerAddress = "";
  private readonly logger: pino.BaseLogger;

  // SDK specific config
  private supportedChains: number[] = [];
  private routerPublicIdentifier?: string;
  private iframeSrc?: string;

  constructor(params: {
    logger?: pino.BaseLogger;
    routerPublicIdentifier?: string;
    supportedChains?: number[];
    iframeSrc?: string;
  }) {
    this.logger = params.logger || pino();
    this.routerPublicIdentifier = params.routerPublicIdentifier;
    this.supportedChains = params.supportedChains || [];
    this.iframeSrc = params.iframeSrc;
  }

  // method for signer-based connections
  static async connect(config: BrowserNodeSignerConfig): Promise<BrowserNode> {
    if (!config.logger) {
      config.logger = pino();
    }
    const node = new BrowserNode({ logger: config.logger });
    // TODO: validate schema
    config.logger.info(
      { method: "connect", publicIdentifier: config.signer.publicIdentifier, signerAddress: config.signer.address },
      "Connecting with provided signer",
    );
    const chainJsonProviders = hydrateProviders(config.chainProviders!);
    const messaging = new NatsMessagingService({
      logger: config.logger.child({ module: "MessagingService" }),
      messagingUrl: config.messagingUrl,
      natsUrl: config.natsUrl,
      authUrl: config.authUrl,
      signer: config.signer,
    });
    await messaging.connect();
    const store = new BrowserStore(config.logger.child({ module: "BrowserStore" }));
    const lock = new BrowserLockService(
      config.signer.publicIdentifier,
      messaging,
      config.logger.child({ module: "BrowserLockService" }),
    );
    const chainService = new VectorChainService(
      store,
      chainJsonProviders,
      config.signer,
      config.logger.child({ module: "VectorChainService" }),
    );
    const engine = await VectorEngine.connect(
      messaging,
      lock,
      store,
      config.signer,
      chainService,
      config.chainAddresses!,
      config.logger.child({ module: "VectorEngine" }),
    );
    node.channelProvider = new DirectProvider(engine);
    node.publicIdentifier = config.signer.publicIdentifier;
    node.signerAddress = config.signer.address;
    return node;
  }

  // method for non-signer based apps to connect to iframe
  async init(): Promise<void> {
    // TODO: validate config
    let iframeSrc = this.iframeSrc;
    if (!iframeSrc) {
      iframeSrc = "https://wallet.connext.network";
    }
    this.logger.info({ method: "connect", iframeSrc }, "Connecting with iframe provider");
    this.channelProvider = await IframeChannelProvider.connect({
      src: iframeSrc!,
      id: "connext-iframe",
    });
    const rpc = constructRpcRequest("connext_authenticate", {});
    const auth = await this.channelProvider.send(rpc);
    this.logger.info({ method: "connect", response: auth }, "Received response from auth method");
    const [nodeConfig] = await this.getConfig();
    this.publicIdentifier = nodeConfig.publicIdentifier;
    this.signerAddress = nodeConfig.signerAddress;
    this.logger.info(
      { supportedChains: this.supportedChains, routerPublicIdentifier: this.routerPublicIdentifier },
      "Checking for existing channels",
    );
    for (const chainId of this.supportedChains) {
      const channelRes = await this.getStateChannelByParticipants({
        chainId,
        counterparty: this.routerPublicIdentifier!,
      });
      if (channelRes.isError) {
        throw channelRes.getError();
      }
      let channel = channelRes.getValue();
      if (!channel) {
        this.logger.info({ chainId }, "Setting up channel");
        const address = await this.setup({
          chainId,
          counterpartyIdentifier: this.routerPublicIdentifier!,
          timeout: "100000",
        });
        if (address.isError) {
          throw address.getError();
        }
        channel = await this.getStateChannel(address.getValue());
      }
      this.logger.info({ channel, chainId });
    }
  }

  // IFRAME SPECIFIC
  async crossChainTransfer(params: {
    amount: string;
    fromChainId: number;
    fromAssetId: string;
    toChainId: number;
    toAssetId: string;
    reconcileDeposit?: boolean;
    withdrawalAddress?: string;
  }): Promise<void> {
    let currentState: string = CROSS_CHAIN_TRANSFER_STATES.BEGIN;

    const crossChainTransferId = getRandomBytes32();
    this.logger.info({ crossChainTransferId, currentState }, "Started cross-chain transfer");

    const senderChannelRes = await this.getStateChannelByParticipants({
      counterparty: this.routerPublicIdentifier!,
      chainId: params.fromChainId,
    });
    if (senderChannelRes.isError) {
      throw senderChannelRes.getError();
    }
    const receiverChannelRes = await this.getStateChannelByParticipants({
      counterparty: this.routerPublicIdentifier!,
      chainId: params.toChainId,
    });
    if (receiverChannelRes.isError) {
      throw receiverChannelRes.getError();
    }
    const senderChannel = senderChannelRes.getValue() as FullChannelState;
    const receiverChannel = receiverChannelRes.getValue() as FullChannelState;
    if (!senderChannel || !receiverChannel) {
      throw new Error(
        `Channel does not exist for chainId ${!senderChannel ? params.fromChainId : params.toChainId} with ${
          this.routerPublicIdentifier
        }`,
      );
    }

    if (params.reconcileDeposit) {
      currentState = CROSS_CHAIN_TRANSFER_STATES.START_DEPOSIT;
      this.logger.info(
        { assetId: params.fromAssetId, channelAddress: senderChannel.channelAddress, currentState },
        "Reconciling deposit",
      );
      const depositRes = await this.reconcileDeposit({
        assetId: params.fromAssetId,
        channelAddress: senderChannel.channelAddress,
      });
      if (depositRes.isError) {
        throw depositRes.getError();
      }
      const updated = await this.getStateChannel({ channelAddress: senderChannel.channelAddress });
      this.logger.info({ updated }, "Deposit reconciled");
    }

    currentState = CROSS_CHAIN_TRANSFER_STATES.START_CREATE_TRANSFER;

    const preImage = getRandomBytes32();
    const lockHash = soliditySha256(["bytes32"], [preImage]);
    this.logger.info({ preImage, lockHash, currentState }, "Sending cross-chain transfer");
    const transferParams = {
      amount: params.amount,
      assetId: params.fromAssetId,
      channelAddress: senderChannel.channelAddress,
      details: {
        lockHash,
        expiry: "0",
      },
      type: TransferNames.HashlockTransfer,
      recipient: this.publicIdentifier,
      recipientAssetId: params.toAssetId,
      recipientChainId: params.toChainId,
      meta: { params, reason: "Cross-chain transfer", routingId: crossChainTransferId },
    };
    const transferRes = await this.conditionalTransfer(transferParams);
    if (transferRes.isError) {
      throw transferRes.getError();
    }

    currentState = CROSS_CHAIN_TRANSFER_STATES.WAIT_FOR_CREATE_TRANSFER;
    const senderTransfer = transferRes.getValue();
    this.logger.warn({ senderTransfer }, "Sender transfer successfully completed, waiting for receiver transfer...");
    const receiverTransferData = await this.waitFor(EngineEvents.CONDITIONAL_TRANSFER_CREATED, 60000, (data) => {
      if (
        data.transfer.meta.routingId === senderTransfer.routingId &&
        data.channelAddress === receiverChannel.channelAddress
      ) {
        return true;
      }
      return false;
    });
    if (!receiverTransferData) {
      this.logger.error(
        { routingId: senderTransfer.routingId, channelAddress: receiverChannel.channelAddress },
        "Failed to get receiver event",
      );
      return;
    }
    currentState = CROSS_CHAIN_TRANSFER_STATES.START_RESOLVE_TRANSFER;

    this.logger.info({ receiverTransferData }, "Received receiver transfer, resolving...");
    const resolveParams = {
      channelAddress: receiverChannel.channelAddress,
      transferId: receiverTransferData.transfer.transferId,
      transferResolver: {
        preImage,
      },
    };
    const resolveRes = await this.resolveTransfer(resolveParams);
    if (resolveRes.isError) {
      throw resolveRes.getError();
    }
    const resolvedTransfer = resolveRes.getValue();
    this.logger.info({ resolvedTransfer }, "Resolved receiver transfer");

    if (params.withdrawalAddress) {
      currentState = CROSS_CHAIN_TRANSFER_STATES.START_WITHDRAW;
      const withdrawalAmount = receiverTransferData.transfer.balance.amount[1];
      this.logger.info(
        { withdrawalAddress: params.withdrawalAddress, withdrawalAmount },
        "Withdrawing to configured address",
      );
      const withdrawRes = await this.withdraw({
        amount: withdrawalAmount, // bob is receiver
        assetId: params.toAssetId,
        channelAddress: receiverChannel.channelAddress,
        recipient: params.withdrawalAddress,
      });
      if (withdrawRes.isError) {
        throw withdrawRes.getError();
      }
      const withdrawal = withdrawRes.getValue();
      this.logger.info({ withdrawal }, "Withdrawal completed");
    }

    currentState = CROSS_CHAIN_TRANSFER_STATES.SUCCESS;
  }
  //////////////////

  createNode(params: NodeParams.CreateNode): Promise<Result<NodeResponses.CreateNode, NodeError>> {
    return Promise.resolve(Result.fail(new NodeError(NodeError.reasons.MultinodeProhibitted, { params })));
  }

  async getConfig(): Promise<NodeResponses.GetConfig> {
    const rpc = constructRpcRequest("chan_getConfig", undefined);
    return this.send(rpc);
  }

  async getStatus(): Promise<Result<NodeResponses.GetStatus, NodeError>> {
    const rpc = constructRpcRequest("chan_getStatus", undefined);
    try {
      const res = await this.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getStateChannelByParticipants(
    params: OptionalPublicIdentifier<NodeParams.GetChannelStateByParticipants>,
  ): Promise<Result<NodeResponses.GetChannelStateByParticipants, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getChannelStateByParticipants">(
        ChannelRpcMethods.chan_getChannelStateByParticipants,
        {
          alice: params.counterparty,
          bob: this.publicIdentifier,
          chainId: params.chainId,
        },
      );
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getStateChannel(
    params: OptionalPublicIdentifier<NodeParams.GetChannelState>,
  ): Promise<Result<NodeResponses.GetChannelState, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getChannelState">(ChannelRpcMethods.chan_getChannelState, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getStateChannels(): Promise<Result<NodeResponses.GetChannelStates, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getChannelStates">(ChannelRpcMethods.chan_getChannelStates, undefined);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res.map((chan) => chan.channelAddress));
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getTransferByRoutingId(
    params: OptionalPublicIdentifier<NodeParams.GetTransferStateByRoutingId>,
  ): Promise<Result<NodeResponses.GetTransferStateByRoutingId, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getTransferStateByRoutingId">(
        ChannelRpcMethods.chan_getTransferStateByRoutingId,
        params,
      );
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getTransfersByRoutingId(
    params: OptionalPublicIdentifier<NodeParams.GetTransferStatesByRoutingId>,
  ): Promise<Result<NodeResponses.GetTransferStatesByRoutingId, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getTransferStatesByRoutingId">(
        ChannelRpcMethods.chan_getTransferStatesByRoutingId,
        params,
      );
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res as NodeResponses.GetTransferStatesByRoutingId);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getTransfer(
    params: OptionalPublicIdentifier<NodeParams.GetTransferState>,
  ): Promise<Result<NodeResponses.GetTransferState, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getTransferState">(ChannelRpcMethods.chan_getTransferState, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getActiveTransfers(
    params: OptionalPublicIdentifier<NodeParams.GetActiveTransfersByChannelAddress>,
  ): Promise<Result<NodeResponses.GetActiveTransfersByChannelAddress, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getActiveTransfers">(ChannelRpcMethods.chan_getActiveTransfers, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async getRegisteredTransfers(
    params: OptionalPublicIdentifier<NodeParams.GetRegisteredTransfers>,
  ): Promise<Result<NodeResponses.GetRegisteredTransfers, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_getRegisteredTransfers">(
        ChannelRpcMethods.chan_getRegisteredTransfers,
        params,
      );
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  async setup(
    params: OptionalPublicIdentifier<NodeParams.RequestSetup>,
  ): Promise<Result<NodeResponses.RequestSetup, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_requestSetup">(ChannelRpcMethods.chan_requestSetup, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok(res);
    } catch (e) {
      return Result.fail(e);
    }
  }

  // OK to leave unimplemented since browser node will never be Alice
  async internalSetup(): Promise<Result<NodeResponses.Setup, NodeError>> {
    throw new Error("Method not implemented");
  }

  // OK to leave unimplemented since all txes can be sent from outside the browser node
  async sendDepositTx(): Promise<Result<NodeResponses.SendDepositTx, NodeError>> {
    throw new Error("Method not implemented.");
  }

  async reconcileDeposit(
    params: OptionalPublicIdentifier<NodeParams.Deposit>,
  ): Promise<Result<NodeResponses.Deposit, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_deposit">(ChannelRpcMethods.chan_deposit, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({ channelAddress: res.channelAddress });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async requestCollateral(
    params: OptionalPublicIdentifier<NodeParams.RequestCollateral>,
  ): Promise<Result<NodeResponses.RequestCollateral, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_requestCollateral">(ChannelRpcMethods.chan_requestCollateral, params);
      await this.channelProvider!.send(rpc);
      return Result.ok({ channelAddress: params.channelAddress });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async conditionalTransfer(
    params: OptionalPublicIdentifier<NodeParams.ConditionalTransfer>,
  ): Promise<Result<NodeResponses.ConditionalTransfer, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_createTransfer">(ChannelRpcMethods.chan_createTransfer, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({
        channelAddress: res.channelAddress,
        transferId: (res.latestUpdate.details as CreateUpdateDetails).transferId,
        routingId: (res.latestUpdate.details as CreateUpdateDetails).meta?.routingId,
      });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async resolveTransfer(
    params: OptionalPublicIdentifier<NodeParams.ResolveTransfer>,
  ): Promise<Result<NodeResponses.ResolveTransfer, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_resolveTransfer">(ChannelRpcMethods.chan_resolveTransfer, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({
        channelAddress: res.channelAddress,
        transferId: (res.latestUpdate.details as CreateUpdateDetails).transferId,
        routingId: (res.latestUpdate.details as CreateUpdateDetails).meta?.routingId,
      });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async withdraw(
    params: OptionalPublicIdentifier<NodeParams.Withdraw>,
  ): Promise<Result<NodeResponses.Withdraw, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_withdraw">(ChannelRpcMethods.chan_withdraw, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({
        channelAddress: res.channel.channelAddress,
        transferId: (res.channel.latestUpdate.details as CreateUpdateDetails).transferId,
        transactionHash: res.transactionHash,
      });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async signUtilityMessage(
    params: OptionalPublicIdentifier<NodeParams.SignUtilityMessage>,
  ): Promise<Result<NodeResponses.SignUtilityMessage, NodeError>> {
    try {
      const rpc = constructRpcRequest<"chan_signUtilityMessage">(ChannelRpcMethods.chan_signUtilityMessage, params);
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({
        signedMessage: res,
      });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async send(payload: EngineParams.RpcRequest): Promise<any> {
    return this.channelProvider!.send(payload);
  }

  //////////////////////
  /// DISPUTE METHODS
  async sendDisputeChannelTx(
    params: OptionalPublicIdentifier<NodeParams.SendDisputeChannelTx>,
  ): Promise<Result<NodeResponses.SendDisputeChannelTx, NodeError>> {
    const rpc = constructRpcRequest(ChannelRpcMethods.chan_dispute, params);
    try {
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({ txHash: res.transactionHash });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async sendDefundChannelTx(
    params: OptionalPublicIdentifier<NodeParams.SendDefundChannelTx>,
  ): Promise<Result<NodeResponses.SendDefundChannelTx, NodeError>> {
    const rpc = constructRpcRequest(ChannelRpcMethods.chan_defund, params);
    try {
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({ txHash: res.transactionHash });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async sendDisputeTransferTx(
    params: OptionalPublicIdentifier<NodeParams.SendDisputeTransferTx>,
  ): Promise<Result<NodeResponses.SendDisputeTransferTx, NodeError>> {
    const rpc = constructRpcRequest(ChannelRpcMethods.chan_disputeTransfer, params);
    try {
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({ txHash: res.transactionHash });
    } catch (e) {
      return Result.fail(e);
    }
  }

  async sendDefundTransferTx(
    params: OptionalPublicIdentifier<NodeParams.SendDefundTransferTx>,
  ): Promise<Result<NodeResponses.SendDefundTransferTx, NodeError>> {
    const rpc = constructRpcRequest(ChannelRpcMethods.chan_defundTransfer, params);
    try {
      const res = await this.channelProvider!.send(rpc);
      return Result.ok({ txHash: res.transactionHash });
    } catch (e) {
      return Result.fail(e);
    }
  }

  waitFor<T extends EngineEvent>(
    event: T,
    timeout: number,
    filter?: (payload: EngineEventMap[T]) => boolean,
  ): Promise<EngineEventMap[T] | undefined> {
    throw new Error("TODO");
    // return this.engine.waitFor(event, timeout, filter);
  }

  async once<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter?: (payload: EngineEventMap[T]) => boolean,
  ): Promise<void> {
    return this.channelProvider!.once(event, callback, filter);
  }

  async on<T extends EngineEvent>(
    event: T,
    callback: (payload: EngineEventMap[T]) => void | Promise<void>,
    filter?: (payload: EngineEventMap[T]) => boolean,
  ): Promise<void> {
    return this.channelProvider!.on(event, callback, filter);
  }

  async off<T extends EngineEvent>(event: T): Promise<void> {
    throw new Error("TODO");
    // return this.engine.off(event);
  }
}
