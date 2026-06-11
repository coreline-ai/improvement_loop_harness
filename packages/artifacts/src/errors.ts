export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

export class ArtifactImmutableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactImmutableError';
  }
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}
