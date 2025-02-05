import { expect, mkAddress } from "@connext/vector-utils";

import { config } from "../../config";
import { ForwardTransferError } from "../../errors";
import { getRebalanceProfile } from "../../services/config";

describe("config.ts", () => {
  const chainId = parseInt(Object.keys(config.chainProviders)[0]);
  describe("getRebalanceProfile", () => {
    it("should fail if rebalance profile does not exist", () => {
      const assetId = mkAddress("0xeee");
      const res = getRebalanceProfile(chainId, assetId);
      expect(res.getError().message).to.be.eq(ForwardTransferError.reasons.UnableToGetRebalanceProfile);
      expect(res.getError().context).to.be.deep.eq({ chainId, assetId });
    });

    it("should return the rebalance profile for given chain/asset", () => {
      const assetId = config.rebalanceProfiles[0].assetId;
      const res = getRebalanceProfile(chainId, assetId);
      expect(res.getError()).to.be.deep.eq(undefined);
      expect(res.getValue()).to.be.deep.eq(config.rebalanceProfiles[0]);
    });
  });
});
