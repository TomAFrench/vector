import {
  ConditionalTransferCreatedPayload,
  ConditionalTransferResolvedPayload,
  Result,
  NodeResponses,
  Values,
  RouterSchemas,
  NodeParams,
  TRANSFER_DECREMENT,
  INodeService,
  FullChannelState,
  IsAlivePayload,
  FullTransferState,
  IVectorChainReader,
  NodeError,
} from "@connext/vector-types";
import { BaseLogger } from "pino";
import { BigNumber } from "@ethersproject/bignumber";

import { getSwappedAmount } from "./services/swap";
import { IRouterStore, RouterUpdateType, RouterUpdateStatus } from "./services/store";
import { ForwardTransferError, ForwardResolutionError } from "./errors";
import {
  cancelCreatedTransfer,
  attemptTransferWithCollateralization,
  transferWithCollateralization,
} from "./services/transfer";

export async function forwardTransferCreation(
  data: ConditionalTransferCreatedPayload,
  routerPublicIdentifier: string,
  routerSignerAddress: string,
  nodeService: INodeService,
  store: IRouterStore,
  logger: BaseLogger,
  chainReader: IVectorChainReader,
): Promise<Result<any, ForwardTransferError>> {
  const method = "forwardTransferCreation";
  logger.info(
    { data, method, node: { routerSignerAddress, routerPublicIdentifier } },
    "Received transfer event, starting forwarding",
  );

  /*
  A note on the transfer event data and conditionalTransfer() params:

  In Indra, we have business logic bleed into several different parts of the stack. This means that adding support for new transfers
  involves making changes to several different places to add support for new params and event types.

  Ideally, all of these changes should now be isolated to the engine. The challenge with this is that consumers of the engine interface
  (or server-node interface) need to pass in the correct params for a given transfer. This means that in the router, we'd need to
  retain context into a conditional transfer type to correctly call the node conditionalTransfer() fn.

  We specifically don't want the router to operate this way. Given this, the best approach I can think of is to structure event/param objects
  for conditional transfer as follows:
  1. Have named fields for all of the data that would actually be needed by the router. This would be: `amount`, `assetId`, `recipientChainId`,
      `recipient`, `recipientAssetId`, `requireOnline`.
  2. Put all other params (basically everything related to the specifics of the condition: `type`, `lockHash`, etc.) into an opaque object
      that the router just catches from the transfer event and passes directly to the server-node.

  Because we're validating the actual conditional params + allowed transfer definitions at the lower levels, this feels safe to do.
  */

  // Create a helper to handle failures in this function by
  // cancelling the transfer that was created on the sender side
  const cancelSenderTransferAndReturnError = async (
    routingId: string,
    senderTransfer: FullTransferState,
    errorReason: Values<typeof ForwardTransferError.reasons>,
    context: any = {},
  ): Promise<Result<any, ForwardTransferError>> => {
    const cancelRes = await cancelCreatedTransfer(
      errorReason,
      senderTransfer,
      routerPublicIdentifier,
      nodeService,
      store,
      logger,
      {
        ...context,
        routingId,
      },
    );
    if (cancelRes.isError) {
      // Failed to execute or enqueue cancellation update
      return Result.fail(cancelRes.getError()!);
    }
    // Cancellation either enqueued or executed
    return Result.fail(
      new ForwardTransferError(errorReason, {
        ...context,
        senderChannel: senderTransfer.channelAddress,
        senderTransfer: senderTransfer.transferId,
        routingId,
        senderTransferCancellation: !!cancelRes.getValue() ? "executed" : "enqueued",
      }),
    );
  };

  const { transfer: senderTransfer, conditionType } = data;
  const {
    balance: {
      amount: [senderAmount],
    },
    assetId: senderAssetId,
    meta: untypedMeta,
    transferState: createdTransferState,
    channelAddress: senderChannelAddress,
    initiator,
    transferTimeout,
    transferDefinition: senderTransferDefinition,
  } = senderTransfer;
  const meta = { ...untypedMeta } as RouterSchemas.RouterMeta & any;
  const { routingId } = meta ?? {};
  const [path] = meta.path ?? [];
  const recipientIdentifier = path?.recipient;
  if (!routingId || !path || !recipientIdentifier) {
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.InvalidForwardingInfo, {
        meta,
        senderTransfer: senderTransfer.transferId,
        senderChannel: senderTransfer.channelAddress,
      }),
    );
  }

  const senderChannelRes = await nodeService.getStateChannel({
    channelAddress: senderChannelAddress,
    publicIdentifier: routerPublicIdentifier,
  });
  if (senderChannelRes.isError) {
    // Cancelling will fail
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.SenderChannelNotFound, {
        nodeError: senderChannelRes.getError()?.message,
      }),
    );
  }
  const senderChannel = senderChannelRes.getValue() as FullChannelState;
  if (!senderChannel) {
    // Cancelling will fail
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.SenderChannelNotFound, {
        channelAddress: senderChannelAddress,
      }),
    );
  }
  const senderChainId = senderChannel.networkContext.chainId;

  // Defaults
  const recipientAssetId = path.recipientAssetId ?? senderAssetId;
  const requireOnline = meta.requireOnline ?? false;
  const recipientChainId = path.recipientChainId ?? senderChainId;

  // Below, we figure out the correct params needed for the receiver's channel. This includes
  // potential swaps/crosschain stuff
  let recipientAmount = senderAmount;
  if (recipientAssetId !== senderAssetId || recipientChainId !== senderChainId) {
    logger.warn({ method, recipientAssetId, senderAssetId, recipientChainId }, "Detected inflight swap");
    const swapRes = getSwappedAmount(senderAmount, senderAssetId, senderChainId, recipientAssetId, recipientChainId);
    if (swapRes.isError) {
      return cancelSenderTransferAndReturnError(
        routingId,
        senderTransfer,
        ForwardTransferError.reasons.UnableToCalculateSwap,
        {
          swapError: swapRes.getError()?.message,
          swapContext: swapRes.getError()?.context,
        },
      );
    }
    recipientAmount = swapRes.getValue();

    logger.warn(
      {
        method,
        recipientAssetId,
        recipientAmount,
        recipientChainId,
        senderTransferDefinition,
        senderAmount,
        senderAssetId,
        conditionType,
      },
      "Inflight swap calculated",
    );
  }

  // Next, get the recipient's channel and figure out whether it needs to be collateralized
  const recipientChannelRes = await nodeService.getStateChannelByParticipants({
    publicIdentifier: routerPublicIdentifier,
    counterparty: recipientIdentifier,
    chainId: recipientChainId,
  });
  if (recipientChannelRes.isError) {
    return cancelSenderTransferAndReturnError(
      routingId,
      senderTransfer,
      ForwardTransferError.reasons.RecipientChannelNotFound,
      {
        storeError: recipientChannelRes.getError()?.message,
      },
    );
  }
  const recipientChannel = recipientChannelRes.getValue() as FullChannelState | undefined;
  if (!recipientChannel) {
    return cancelSenderTransferAndReturnError(
      routingId,
      senderTransfer,
      ForwardTransferError.reasons.RecipientChannelNotFound,
      {
        participants: [routerPublicIdentifier, recipientIdentifier],
        chainId: recipientChainId,
      },
    );
  }

  // Create the params you will transfer with
  const { balance, ...details } = createdTransferState;
  const newMeta = {
    // Node is never the initiator, that is always payment sender
    senderIdentifier: initiator === senderChannel.bob ? senderChannel.bobIdentifier : senderChannel.aliceIdentifier,
    ...meta,
  };
  const params = {
    channelAddress: recipientChannel.channelAddress,
    amount: recipientAmount,
    assetId: recipientAssetId,
    timeout: BigNumber.from(transferTimeout).sub(TRANSFER_DECREMENT).toString(),
    type: conditionType,
    publicIdentifier: routerPublicIdentifier,
    details,
    meta: newMeta,
  };
  logger.info({ params, method }, "Generated new transfer params");

  const transferRes = await attemptTransferWithCollateralization(
    params,
    recipientChannel,
    routerPublicIdentifier,
    nodeService,
    store,
    chainReader,
    logger,
    requireOnline,
  );
  if (!transferRes.isError) {
    // transfer was either queued or executed
    const value = transferRes.getValue();
    return !!value
      ? Result.ok(value)
      : Result.fail(
          new ForwardTransferError(ForwardTransferError.reasons.ReceiverOffline, {
            routingId,
            senderTransfer: senderTransfer.transferId,
            recipientChannel: recipientChannel.channelAddress,
          }),
        );
  }

  // check if you should cancel the sender
  const error = transferRes.getError()!;
  if (error.context.shouldCancelSender) {
    logger.warn({ ...error }, "Cancelling sender-side transfer");
    return cancelSenderTransferAndReturnError(routingId, senderTransfer, error.message);
  }

  // return failure without cancelling
  return Result.fail(transferRes.getError()!);
}

export async function forwardTransferResolution(
  data: ConditionalTransferResolvedPayload,
  routerPublicIdentifier: string,
  routerSignerAddress: string,
  nodeService: INodeService,
  store: IRouterStore,
  logger: BaseLogger,
): Promise<Result<undefined | NodeResponses.ResolveTransfer, ForwardResolutionError>> {
  const method = "forwardTransferResolution";
  logger.info(
    { data, method, node: { routerSignerAddress, routerPublicIdentifier } },
    "Received transfer resolution, starting forwarding",
  );
  const {
    channelAddress,
    transfer: { transferId, transferResolver, meta },
  } = data;
  const { routingId } = meta as RouterSchemas.RouterMeta;

  // Find the channel with the corresponding transfer to unlock
  const transfersRes = await nodeService.getTransfersByRoutingId({
    routingId,
    publicIdentifier: routerPublicIdentifier,
  });
  if (transfersRes.isError) {
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.IncomingChannelNotFound, {
        routingId,
        error: transfersRes.getError()?.message,
      }),
    );
  }

  // find transfer where node is responder
  const incomingTransfer = transfersRes.getValue().find((transfer) => transfer.responder === routerSignerAddress);

  if (!incomingTransfer) {
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.IncomingChannelNotFound, {
        routingId,
      }),
    );
  }

  // Resolve the sender transfer
  const resolveParams: NodeParams.ResolveTransfer = {
    channelAddress: incomingTransfer.channelAddress,
    transferId: incomingTransfer.transferId,
    meta: {},
    transferResolver,
    publicIdentifier: routerPublicIdentifier,
  };
  const resolution = await nodeService.resolveTransfer(resolveParams);
  if (resolution.isError) {
    // Store the transfer, retry later
    // TODO: add logic to periodically retry resolving transfers
    const type = RouterUpdateType.TRANSFER_RESOLUTION;
    await store.queueUpdate(incomingTransfer.channelAddress, type, resolveParams);
    return Result.fail(
      new ForwardResolutionError(ForwardResolutionError.reasons.ErrorResolvingTransfer, {
        message: resolution.getError()?.message,
        routingId,
        transferResolver,
        incomingTransferChannel: incomingTransfer.channelAddress,
        recipientTransferId: transferId,
        recipientChannelAddress: channelAddress,
      }),
    );
  }

  return Result.ok(resolution.getValue());
}

export async function handleIsAlive(
  data: IsAlivePayload,
  routerPublicIdentifier: string,
  signerAddress: string,
  nodeService: INodeService,
  store: IRouterStore,
  chainReader: IVectorChainReader,
  logger: BaseLogger,
): Promise<Result<undefined, ForwardTransferError>> {
  const method = "handleIsAlive";
  logger.info(
    { data, method, node: { signerAddress, routerPublicIdentifier } },
    "Received isAlive event, starting handler",
  );

  if (data.skipCheckIn) {
    logger.info({ method, data }, "Skipping isAlive handler");
    return Result.ok(undefined);
  }
  // This means the user is online and has checked in. Get all updates that are
  // queued and then execute them.
  const updates = await store.getQueuedUpdates(data.channelAddress, RouterUpdateStatus.PENDING);

  // Get the channel (if needed, should only query 1x for it)
  const channelRes = await nodeService.getStateChannel({ channelAddress: data.channelAddress });
  if (channelRes.isError || !channelRes.getValue()) {
    // Do not proceed with processing updates
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.CheckInError, {
        getChannelError: channelRes.getError()?.message,
      }),
    );
  }
  const channel = channelRes.getValue() as FullChannelState;

  const erroredUpdates = [];
  for (const routerUpdate of updates) {
    // set status to processing to avoid race conditions
    await store.setUpdateStatus(routerUpdate.id, RouterUpdateStatus.PROCESSING);
    logger.info({ method, update: routerUpdate }, "Found update for checkIn channel");
    const { type, payload } = routerUpdate;

    // Handle transfer creation updates
    if (type === RouterUpdateType.TRANSFER_CREATION) {
      // NOTE: this will *NOT* perform any additional liveness checks
      // and it is assumed the receiver will stay online throughout the
      // processing of these updates
      const createRes = await transferWithCollateralization(
        payload as NodeParams.ConditionalTransfer,
        channel,
        routerPublicIdentifier,
        nodeService,
        chainReader,
        logger,
      );
      if (createRes.isError) {
        logger.error(
          { createError: createRes.getError()?.message, update: routerUpdate },
          "Handling router update failed",
        );
        const error = createRes.getError()?.context?.transferError;
        await store.setUpdateStatus(
          routerUpdate.id,
          error === NodeError.reasons.Timeout ? RouterUpdateStatus.PENDING : RouterUpdateStatus.FAILED,
          error,
        );
        erroredUpdates.push(routerUpdate);
      } else {
        logger.info({ update: routerUpdate.id, method }, "Successfully handled checkIn update");
      }
      continue;
    }

    // Handle transfer resolution updates
    if (type !== RouterUpdateType.TRANSFER_RESOLUTION) {
      logger.error({ update: routerUpdate }, "Unknown update type");
      await store.setUpdateStatus(routerUpdate.id, RouterUpdateStatus.FAILED, "Unknown update type");
      continue;
    }
    const resolveRes = await nodeService.resolveTransfer(payload as NodeParams.ResolveTransfer);
    // If failed, retry later
    if (resolveRes.isError) {
      logger.error({ resolveError: resolveRes.getError()?.message, routerUpdate }, "Handling router update failed");
      const error = resolveRes.getError()?.message;
      await store.setUpdateStatus(
        routerUpdate.id,
        error === NodeError.reasons.Timeout ? RouterUpdateStatus.PENDING : RouterUpdateStatus.FAILED,
        error,
      );
      erroredUpdates.push(routerUpdate);
    } else {
      logger.info({ update: routerUpdate.id, method }, "Successfully handled checkIn update");
    }
  }
  if (erroredUpdates.length > 0) {
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.CheckInError, {
        failedIds: erroredUpdates.map((update) => update.id),
      }),
    );
  }
  return Result.ok(undefined);
}
