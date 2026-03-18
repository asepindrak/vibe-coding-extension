(function () {
  const workflowHelpers = () => window.VicoWorkflowHelpers || {};

  function extractLegacyExecutePayload(stepOutput, stepType) {
    const text = String(stepOutput || "").trim();
    if (!text) return null;
    if (/\[(?:writeFile|writeFileVico|command|REPLAN)\]/i.test(text)) {
      return null;
    }

    const resolveCommand = function () {
      if (String(stepType || "").toLowerCase() !== "terminal_command") {
        return null;
      }
      const commandMatch =
        text.match(/"command"\s*:\s*"([^"]+)"/i) ||
        text.match(/'command'\s*:\s*'([^']+)'/i) ||
        text.match(/\bcommand\s*:\s*([^\n]+)/i);
      return commandMatch ? String(commandMatch[1] || "").trim() : null;
    };

    const parseEchoRedirectWrite = function (command) {
      const match = String(command || "").match(
        /^\s*(?:cat\s*<<['"]?EOF['"]?\s*>\s*|printf\s+['"`][\s\S]*?['"`]\s*>\s*|echo\s+)(.+)$/i,
      );
      return match ? String(match[1] || "").trim() : null;
    };

    const command = resolveCommand();
    if (!command) return null;
    if (String(stepType || "").toLowerCase() === "file_write") {
      const writePayload = parseEchoRedirectWrite(command);
      if (writePayload) return writePayload;
    }
    return `[command]\n${command}\n[/command]`;
  }

  function normalizeExecuteStepOutput(inputs) {
    const { hasWritableBlocks } = workflowHelpers();
    let stepOutput = String(inputs.stepOutput || "");
    let context = String(inputs.context || "");
    let notices = [];

    const legacyPayload = extractLegacyExecutePayload(stepOutput, inputs.stepType);
    if (legacyPayload) {
      stepOutput = legacyPayload;
      if (!/\[(?:writeFile|writeFileVico|command|REPLAN)\]/i.test(stepOutput)) {
        context +=
          `\n[System Feedback] Execute output was legacy JSON-plan format; auto-converted to executable agent tags.\n`;
        notices.push(
          `\n> *âš ï¸ Legacy execute output detected and auto-converted to executable tags.*\n`,
        );
      }
    }

    if (
      String(inputs.stepType || "").toLowerCase() === "file_write" &&
      !/\[(?:writeFile|writeFileVico)\]/i.test(stepOutput) &&
      /\[(?:file|diff)\s+/i.test(stepOutput)
    ) {
      stepOutput = `[writeFile]\n${stepOutput.trim()}\n[/writeFile]`;
      context +=
        `\n[System Feedback] Auto-wrapped bare [file]/[diff] output into [writeFile] for execution.\n`;
    }

    if (
      String(inputs.stepType || "").toLowerCase() === "file_write" &&
      !/\[(?:writeFile|writeFileVico)\]/i.test(stepOutput)
    ) {
      const codeBlockMatch = stepOutput.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
      if (codeBlockMatch) {
        const code = codeBlockMatch[1].trim();
        const stepHint = String(inputs.stepDescription || "");
        const fileNameMatch =
          stepHint.match(
            /(?:read|write|modify|update|create|edit|overwrite|replace)\s+[`'"]?([^`'"\s]+(?:\.[A-Za-z0-9._-]+)?)[`'"]?/i,
          ) ||
          stepHint.match(/[`'"]([^`'"]+\.[A-Za-z0-9._-]+)[`'"]/i) ||
          stepHint.match(/\b([A-Za-z0-9_./\\-]+\.[A-Za-z0-9._-]+)\b/);
        if (fileNameMatch) {
          const fileName = fileNameMatch[1].replace(/\\/g, "/");
          stepOutput = `[writeFile]\n[file name="${fileName}"]\n${code}\n[/file]\n[/writeFile]`;
          context += `\n[System Feedback] Auto-wrapped raw markdown code block into [writeFile] for ${fileName}.\n`;
        }
      }
    }

    const hasWriteFileTag = /\[(?:writeFile|writeFileVico)\]/i.test(stepOutput);
    let formatWarnings = [];
    if (hasWriteFileTag) {
      stepOutput = stepOutput.replace(/\[(\/?)writeFileVico\s*\]/gi, "[$1writeFile]");
      const writeFileMatch = stepOutput.match(/\[writeFile\][\s\S]*?\[\/writeFile\]/i);
      if (writeFileMatch) {
        stepOutput = writeFileMatch[0];
      }

      const hasClosingTag = /\[\/(?:writeFile|writeFileVico)\]/i.test(stepOutput);
      const { hasFileBlock, hasDiffBlock } = hasWritableBlocks(stepOutput);

      if (!hasClosingTag) {
        formatWarnings.push(
          `\n> âš ï¸ **Format Warning:** Missing closing [/writeFile] tag\n`,
        );
      }
      if (!hasFileBlock && !hasDiffBlock) {
        formatWarnings.push(
          `\n> âš ï¸ **Format Warning:** No [file] or [diff] blocks found inside [writeFile]\n`,
        );
      }
    }

    return {
      stepOutput,
      context,
      notices,
      hasWriteFileTag,
      formatWarnings,
    };
  }

  function appendExecutionOutputMarkdown(inputs) {
    let planMarkdown = String(inputs.planMarkdown || "");
    if (inputs.hasWriteFileTag) {
      planMarkdown += `\n${inputs.stepOutput}\n`;
    } else {
      planMarkdown += `\n> *Execution Output:*\n\`\`\`\n${String(inputs.stepOutput || "").slice(0, 1000)}${String(inputs.stepOutput || "").length > 1000 ? "..." : ""}\n\`\`\`\n`;
    }
    return planMarkdown;
  }

  window.VicoExecuteLoopHelpers = {
    extractLegacyExecutePayload: extractLegacyExecutePayload,
    normalizeExecuteStepOutput: normalizeExecuteStepOutput,
    appendExecutionOutputMarkdown: appendExecutionOutputMarkdown,
  };
  window.normalizeExecuteStepOutput = normalizeExecuteStepOutput;
  window.appendExecutionOutputMarkdown = appendExecutionOutputMarkdown;
})();
