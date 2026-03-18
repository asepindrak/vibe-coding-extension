(function () {
  const workflowHelpers = window.VicoWorkflowHelpers || {};
  const getWriteTargetMatches = workflowHelpers.getWriteTargetMatches;

  function sanitizeExecutionText(text) {
    return String(text || "")
      .replace(
        /\[(?:writeFile|writeFileVico)\][\s\S]*?\[\/(?:writeFile|writeFileVico)\]/g,
        "[writeFile block]",
      )
      .replace(/\[command\][\s\S]*?\[\/command\]/g, "[command block]")
      .replace(/\[readFile\][\s\S]*?\[\/readFile\]/g, "[readFile block]")
      .replace(/\s+/g, " ")
      .trim();
  }

  function summarizeExecutionOutput(step, output) {
    const changedFiles = getWriteTargetMatches(output).map(function (m) {
      return m.path;
    });
    const commandMatch = String(output || "").match(
      /\[command\s*\]([\s\S]*?)\[\/command\s*\]/i,
    );

    return {
      step: step && step.step,
      description: step && step.description,
      changed_files: Array.from(new Set(changedFiles)).slice(0, 20),
      command: commandMatch ? commandMatch[1].trim().slice(0, 500) : "",
      has_replan: /\[REPLAN\s*\]/i.test(String(output || "")),
      has_write: /\[(?:writeFile|writeFileVico)\s*\]/i.test(
        String(output || ""),
      ),
      short_output: sanitizeExecutionText(output).slice(0, 1500),
      at: new Date().toISOString(),
    };
  }

  function collectWriteTargets(text) {
    const matches = getWriteTargetMatches(text);
    const targetFiles = Array.from(
      new Set(
        matches.map(function (m) {
          return m.path;
        }),
      ),
    );
    const diffTargets = Array.from(
      new Set(
        matches
          .filter(function (m) {
            return m.kind === "diff";
          })
          .map(function (m) {
            return m.path;
          }),
      ),
    );
    return {
      matches: matches,
      targetFiles: targetFiles,
      diffTargets: diffTargets,
    };
  }

  function normalizeFileBlockContent(content) {
    const trimmed = String(content || "").trim();
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      return trimmed.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "");
    }
    return String(content || "");
  }

  function readFileWithTimeout(vscode, filePath, timeoutMs, filePathCache) {
    return new Promise(function (resolve) {
      let handleMessage;
      const timeout = setTimeout(function () {
        window.removeEventListener("message", handleMessage);
        resolve(null);
      }, timeoutMs || 10000);
      handleMessage = function (event) {
        if (
          event.data.command === "readFileResult" &&
          event.data.filePath === filePath
        ) {
          clearTimeout(timeout);
          window.removeEventListener("message", handleMessage);
          if (
            event.data.resolvedPath &&
            event.data.resolvedPath !== filePath &&
            filePathCache
          ) {
            filePathCache.set(filePath, event.data.resolvedPath);
          }
          if (event.data.error) resolve(null);
          else resolve(event.data.content || "");
        }
      };
      window.addEventListener("message", handleMessage);
      vscode.postMessage({ type: "readFile", filePath: filePath });
    });
  }

  function waitForWriteFile(vscode, assistantMessage, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let handleMessage;
      let handleStop;

      const timeout = setTimeout(function () {
        window.removeEventListener("message", handleMessage);
        window.removeEventListener("agent-stop", handleStop);
        resolve();
      }, timeoutMs || 10000);

      handleStop = function () {
        clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        window.removeEventListener("agent-stop", handleStop);
        const err = new Error("Aborted by user");
        err.name = "AbortError";
        reject(err);
      };

      handleMessage = function (event) {
        if (event.data.command === "writeFileFinished") {
          clearTimeout(timeout);
          window.removeEventListener("message", handleMessage);
          window.removeEventListener("agent-stop", handleStop);
          resolve();
        }
      };
      window.addEventListener("message", handleMessage);
      window.addEventListener("agent-stop", handleStop);

      vscode.postMessage({
        type: "writeFile",
        assistantMessage: assistantMessage,
      });
    });
  }

  function executeCommandWithStreaming(vscode, options) {
    return new Promise(function (resolve, reject) {
      let terminalOutput = options.initialOutput || "";
      let handleMessage;
      let handleStop;

      handleStop = function () {
        window.removeEventListener("message", handleMessage);
        window.removeEventListener("agent-stop", handleStop);
        const err = new Error("Aborted by user");
        err.name = "AbortError";
        reject(err);
      };

      handleMessage = function (event) {
        if (event.data.command === "commandOutput") {
          terminalOutput += event.data.output;
          if (typeof options.onOutput === "function") {
            options.onOutput(terminalOutput);
          }
        }
        if (event.data.command === "commandFinished") {
          window.removeEventListener("message", handleMessage);
          window.removeEventListener("agent-stop", handleStop);

          if (terminalOutput.trim().length === 0) {
            terminalOutput += "(See VS Code Terminal for output)";
          }

          if (event.data.output) {
            terminalOutput = event.data.output;
          }

          if (event.data.exitCode !== 0) {
            terminalOutput +=
              "\n\n[Process exited with code " + event.data.exitCode + "]";
          } else {
            terminalOutput += "\n\n[Process completed successfully]";
          }

          if (terminalOutput.length > 500000) {
            terminalOutput =
              terminalOutput.slice(0, 500000) +
              "\n... [Output truncated (too large for context). Please refine command with exclusions.]";
          }

          if (typeof options.onFinished === "function") {
            options.onFinished(terminalOutput, event.data.exitCode);
          }

          resolve({
            exitCode: event.data.exitCode,
            output: terminalOutput,
          });
        }
        if (event.data.command === "commandStopped") {
          window.removeEventListener("message", handleMessage);
          window.removeEventListener("agent-stop", handleStop);
          terminalOutput += "\n\n[Process stopped by user]";

          if (typeof options.onStopped === "function") {
            options.onStopped(terminalOutput);
          }

          const err = new Error("Aborted by user");
          err.name = "AbortError";
          reject(err);
        }
      };

      window.addEventListener("message", handleMessage);
      window.addEventListener("agent-stop", handleStop);
      vscode.postMessage({ type: "executeCommand", command: options.command });
    });
  }

  function analyzeCommandFailure(inputs) {
    const terminalOutput = String(inputs.terminalOutput || "");
    const command = String(inputs.command || "");
    const exitCode = Number(inputs.exitCode || 0);
    const isVanilla = !!inputs.userRequestedVanillaNoFramework;
    const isAlreadyScaffoldedError =
      /Blocked:\s*workspace already has dependency file/i.test(
        terminalOutput,
      ) || /already scaffolded/i.test(terminalOutput);
    const isScaffoldMissingError =
      /Blocked:\s*workspace has no dependency file yet/i.test(terminalOutput);
    const isPackageJsonParseError =
      /EJSONPARSE|Invalid package\.json|package\.json must be actual JSON/i.test(
        terminalOutput,
      );
    const missingNameMatch =
      /Cannot find name '([A-Za-z0-9_]+)'/i.exec(terminalOutput);
    const missingSymbol = missingNameMatch ? missingNameMatch[1] : "";
    const isMissingImportError =
      !!missingSymbol && /^[A-Z]/.test(missingSymbol);
    const isDbConnectionError =
      /P1001|P1012|ECONNREFUSED|Access denied for user|Unknown database/i.test(
        terminalOutput,
      );

    const failureGuidance = isScaffoldMissingError
      ? isVanilla
        ? '\n[System Feedback] Command "' +
          command +
          '" was blocked because no dependency manifest exists.\n[System Feedback] User explicitly requested NO FRAMEWORK/vanilla web. Do NOT scaffold Next.js.\n[System Feedback] Continue with direct file edits (index.html/script.js/styles.css) and avoid npm build/dev unless explicitly required.\n'
        : '\n[System Feedback] Command "' +
          command +
          '" was blocked because workspace is not scaffolded yet.\n[System Feedback] NEXT PLAN MUST start with scaffold command:\n[System Feedback] [command] npx create-next-app . --yes --ts --eslint --tailwind --app --use-npm [/command]\n[System Feedback] Do not run npm install/build/test/dev before scaffold succeeds.\n'
      : isPackageJsonParseError
        ? '\n[System Feedback] Command "' +
          command +
          '" failed with JSON parse error in package.json.\n[System Feedback] Do not rerun build/test/install first. Read package.json, remove comments/trailing commas/invalid JSON syntax, then validate JSON and retry the original command.\n'
        : isMissingImportError
          ? "\n[System Feedback] Build failed with missing symbol '" +
            missingSymbol +
            "'. This usually means JSX/component is used without import.\n[System Feedback] Fix code FIRST: add/import '" +
            missingSymbol +
            "' in the relevant file (likely app/page.tsx) or use correct component name/export.\n[System Feedback] Do NOT rerun build until file_write fixes are applied.\n"
          : '\n[System Feedback] Command "' +
            command +
            '" failed (exit ' +
            exitCode +
            "). Analyze terminal output, apply concrete fix, then retry once and continue original request.\n";

    let planNote =
      "\n> *Ã¢Å¡Â Ã¯Â¸Â Command failed. Agent will fix the root cause and replan in the next iteration.*\n";
    if (isScaffoldMissingError) {
      planNote =
        "\n> *Ã¢Å¡Â Ã¯Â¸Â Command blocked: project not scaffolded. Agent will scaffold framework first, then continue.*\n";
    } else if (isPackageJsonParseError) {
      planNote =
        "\n> *Ã¢Å¡Â Ã¯Â¸Â Command failed: package.json is invalid JSON. Agent will fix package.json before retrying build/test/install.*\n";
    } else if (isMissingImportError) {
      planNote =
        "\n> *Ã¢Å¡Â Ã¯Â¸Â Build failed: missing import/symbol '" +
        missingSymbol +
        "'. Agent will fix file imports/exports before retrying build.*\n";
    } else if (isDbConnectionError) {
      planNote =
        "\n> *Ã¢Å¡Â Ã¯Â¸Â Database connection failed. Agent will ask for credentials or fix configuration.*\n";
    }

    return {
      isAlreadyScaffoldedError: isAlreadyScaffoldedError,
      isScaffoldMissingError: isScaffoldMissingError,
      isPackageJsonParseError: isPackageJsonParseError,
      isMissingImportError: isMissingImportError,
      isDbConnectionError: isDbConnectionError,
      missingSymbol: missingSymbol,
      dbType: terminalOutput.includes("mysql") ? "MySQL" : "Database",
      failureGuidance: failureGuidance,
      planNote: planNote,
    };
  }

  window.VicoExecutionHelpers = {
    summarizeExecutionOutput: summarizeExecutionOutput,
    collectWriteTargets: collectWriteTargets,
    normalizeFileBlockContent: normalizeFileBlockContent,
    readFileWithTimeout: readFileWithTimeout,
    waitForWriteFile: waitForWriteFile,
    executeCommandWithStreaming: executeCommandWithStreaming,
    analyzeCommandFailure: analyzeCommandFailure,
  };
  window.summarizeExecutionOutput = summarizeExecutionOutput;
  window.collectWriteTargets = collectWriteTargets;
  window.normalizeFileBlockContent = normalizeFileBlockContent;
  window.readFileWithTimeout = readFileWithTimeout;
  window.waitForWriteFile = waitForWriteFile;
  window.executeCommandWithStreaming = executeCommandWithStreaming;
  window.analyzeCommandFailure = analyzeCommandFailure;
})();
