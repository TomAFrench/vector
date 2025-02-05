import { Result } from "@connext/vector-types";

import { config, RebalanceProfile } from "../config";
import { ForwardTransferError } from "../errors";

export const getRebalanceProfile = (
  chainId: number,
  assetId: string,
): Result<RebalanceProfile, ForwardTransferError> => {
  const rebalanceProfile = config.rebalanceProfiles.find(
    (profile) => profile.assetId === assetId && profile.chainId === chainId,
  );
  if (!rebalanceProfile) {
    return Result.fail(
      new ForwardTransferError(ForwardTransferError.reasons.UnableToGetRebalanceProfile, { chainId, assetId }),
    );
  }

  return Result.ok(rebalanceProfile);
};
