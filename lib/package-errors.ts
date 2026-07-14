export class PackageBillingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    status = 409,
    retryable = false,
  ) {
    super(message);
    this.name = "PackageBillingError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function packageErrorResponse(error: unknown) {
  if (error instanceof PackageBillingError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "package_billing_internal_error",
        message: error instanceof Error ? error.message : "套餐计费操作失败",
        retryable: false,
      },
    },
  };
}
