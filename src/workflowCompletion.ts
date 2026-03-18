export interface CompletionInputs {
  recoveryPending: boolean;
  recoveryStepExecuted: boolean;
  verificationOnlyPlan: boolean;
  hadStepError: boolean;
  autoFixTriggered: boolean;
}

export interface CompletionState {
  recoverySatisfied: boolean;
  canUseCompletionShortcut: boolean;
}

export function getCompletionState(
  inputs: CompletionInputs,
): CompletionState {
  const recoverySatisfied =
    inputs.recoveryStepExecuted ||
    (inputs.verificationOnlyPlan &&
      !inputs.hadStepError &&
      !inputs.autoFixTriggered);

  return {
    recoverySatisfied,
    canUseCompletionShortcut:
      !inputs.recoveryPending || recoverySatisfied,
  };
}
