import { CustomError } from "../../../app/core/definitions/custom-error";

import { CreateChannelErrorImpl } from "./create-channel.err.impl";
import { GeneralErrorImpl } from "./general.err.impl";
import { ValidationErrorImpl } from "./validation.err.impl";

export const ERRORS: Record<string, CustomError> = {
  general: new GeneralErrorImpl(),
  validation: new ValidationErrorImpl(),
  createChannel: new CreateChannelErrorImpl(),
};
