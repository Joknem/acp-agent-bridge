let turnSequence = 0;

export function createTurnId(prefix = "turn") {
  turnSequence = (turnSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${turnSequence.toString(36)}`;
}
