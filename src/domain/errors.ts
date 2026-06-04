export class TachikomaError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ValidationError extends TachikomaError {
  public constructor(message: string) {
    super("ValidationError", message);
  }
}

export class RoutingTargetNotFoundError extends TachikomaError {
  public constructor(target: string) {
    super("RoutingTargetNotFound", `Routing target ${target} was not found.`);
  }
}

export class RoutingTargetAmbiguousError extends TachikomaError {
  public constructor(target: string, candidates: string[]) {
    super(
      "RoutingTargetAmbiguous",
      `Routing target ${target} is ambiguous. Candidates: ${candidates.join(", ")}.`
    );
  }
}

export class StoreUnavailableError extends TachikomaError {
  public constructor(storePath: string) {
    super("StoreUnavailable", `Tachikoma store is unavailable at ${storePath}.`);
  }
}

export class MigrationFailedError extends TachikomaError {
  public constructor(message: string) {
    super("MigrationFailed", `SQLite migration failed: ${message}`);
  }
}

export class EventNotFoundError extends TachikomaError {
  public constructor(eventId: string) {
    super("EventNotFound", `Event ${eventId} was not found.`);
  }
}
