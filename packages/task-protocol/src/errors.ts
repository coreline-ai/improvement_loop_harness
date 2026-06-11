export class SchemaValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[]) {
    super(`${message}: ${details.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.details = details;
  }
}

export class TaskProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskProtocolError';
  }
}

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalConfigError';
  }
}

export class InterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpolationError';
  }
}
