(function () {
  function getCompletionState(inputs) {
    const recoverySatisfied =
      inputs.recoveryStepExecuted ||
      (inputs.verificationOnlyPlan &&
        !inputs.hadStepError &&
        !inputs.autoFixTriggered);

    return {
      recoverySatisfied: recoverySatisfied,
      canUseCompletionShortcut:
        !inputs.recoveryPending || recoverySatisfied,
    };
  }

  function getWriteTargetMatches(text) {
    return Array.from(
      String(text || "").matchAll(
        /\[(file|diff)\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]/gi,
      ),
    )
      .map(function (m) {
        return {
          kind:
            String(m[1] || "").toLowerCase() === "diff" ? "diff" : "file",
          path: String(m[2] || "").trim(),
        };
      })
      .filter(function (m) {
        return m.path;
      });
  }

  function hasWritableBlocks(text) {
    const targets = getWriteTargetMatches(text);
    return {
      hasFileBlock: targets.some(function (t) {
        return t.kind === "file";
      }),
      hasDiffBlock: targets.some(function (t) {
        return t.kind === "diff";
      }),
    };
  }

  function getFilePayloadBlocks(text) {
    return Array.from(
      String(text || "").matchAll(
        /\[file\s+(?:name|path)=["']?([^"'\s\]]+)["']?(?:\s+type=["'][^"']+["'])?\]([\s\S]*?)(?:\[\s*\/file\s*\]|(?=\[\/?(?:file|diff|writeFile|writeFileVico))|$)/gi,
      ),
    )
      .map(function (m) {
        return {
          path: String(m[1] || "").trim(),
          content: String(m[2] || ""),
        };
      })
      .filter(function (m) {
        return m.path;
      });
  }

  window.VicoWorkflowHelpers = {
    getCompletionState: getCompletionState,
    getWriteTargetMatches: getWriteTargetMatches,
    hasWritableBlocks: hasWritableBlocks,
    getFilePayloadBlocks: getFilePayloadBlocks,
  };
  window.getCompletionState = getCompletionState;
  window.getWriteTargetMatches = getWriteTargetMatches;
  window.hasWritableBlocks = hasWritableBlocks;
  window.getFilePayloadBlocks = getFilePayloadBlocks;
})();
