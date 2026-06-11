export class EvalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalEngineError';
  }
}

export class EvalInterpolationError extends EvalEngineError {
  constructor(message: string) {
    super(message);
    this.name = 'EvalInterpolationError';
  }
}

export class BuiltinGateError extends EvalEngineError {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltinGateError';
  }
}
