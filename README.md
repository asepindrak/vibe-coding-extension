# Vibe Coding (VICO) --- AI Coding Agent for VS Code

Vibe Coding is an AI-powered coding assistant and autonomous agent built
for developers who want more than just chat.\
From inline completions to full multi-step task execution --- VICO works
directly inside your workspace.

![Vibe Coding Logo](media/vibe-coding-logo.png) ![Vibe Coding SS
1](media/vibe-coding-ss-1.png) ![Vibe Coding SS
2](media/vibe-coding-ss-2.png)

---

# 🚀 What's New in v2 (Major Update)

## 🤖 Agent Mode --- Autonomous Task Execution

Turn Vibe Coding into a real AI coding agent.

Agent Mode can:

- Plan tasks automatically\
- Think step-by-step before execution\
- Execute actions directly in your workspace

### The agent can:

- 📄 Read files and analyze code
- ✏️ Modify files using diff-based updates
- 🆕 Create new files
- 🖥 Execute terminal commands
- 🧠 Reason per step before making changes

### Example use cases:

- Refactor entire modules
- Implement features across multiple files
- Fix complex bugs with multi-step reasoning
- Run migrations or build commands

Just describe the task.\
VICO handles the plan → reasoning → execution cycle automatically.

---

## 🖼 File & Image Upload Support (Multimodal Input)

You can now provide richer context to the AI.

### Supported methods:

- 📂 Select files via file browser
- 📋 Paste content directly
- 🖱 Drag & drop files into chat

### Use cases:

- Upload screenshots of errors
- Share design mockups
- Provide log files
- Attach documentation
- Send existing code for deeper analysis

The AI automatically includes uploaded content in its reasoning context.

---

# ✨ Core Features

## Programming Assistance

Get help with coding problems, syntax errors, refactoring advice, and
best practices.

## Interactive Chat

Real-time AI chat inside VS Code.

## Select Code to AI

Highlight any code and instantly ask for: - Explanation - Debugging
help - Refactoring - Optimization

## Continue Code from Comment (Shift + Enter)

Write a comment describing what you want, then: 👉 Press `Shift + Enter`

The AI will continue your code based on the comment context.

## Auto Code Suggestions

Context-aware suggestions based on your coding patterns and project
structure.

## Code Completions

Start typing and let AI complete your line intelligently.\
👉 Press `Shift + Enter + .` after your code.

## Generate Full CRUD Pages from Model Schema

Automatically generate complete frontend components from a model
description.

Example prompt: "Generate model Goat with field: id, name, age, breed"

Generated files: - model.schema.ts (Zod validation) - ModelForm.tsx -
ModelList.tsx - ModelDetailView.tsx - model.action.ts

Files are saved under: `src/models/<model-name>/`

## Teach AI Current Code 🔄

Improve AI accuracy by training it with a sampled subset of your
workspace.

Note: Only a sampled subset is used --- not the full project.

---

# 🧠 Why Vibe Coding v2 is Different

Feature Basic AI Chat Vibe Coding v2

---

Chat Assistance ✅ ✅
Code Completion ✅ ✅
Multi-file Refactor ❌ ✅
Terminal Execution ❌ ✅
Step-by-step Planning ❌ ✅
File & Image Upload ❌ ✅

VICO is not just a chatbot.\
It is an AI coding agent.

---

# 📦 Installation

1.  Open VS Code
2.  Go to Extensions
3.  Search for "Vibe Coding"
4.  Click Install
5.  Open the Vibe Coding sidebar
6.  Login and start building

---

# 💻 Usage

1.  Open Vibe Coding sidebar
2.  Login
3.  Start chatting or activate Agent Mode
4.  Select code or describe tasks
5.  Let the AI assist or execute autonomously

Example tasks: - "Refactor this service to use repository pattern" -
"Fix all TypeScript errors in this folder" - "Create authentication
module with JWT" - "Generate CRUD for Product model"

---

# 🛠 Upcoming Features

- Backend code generation (controllers, services, routes)
- Custom file templates
- Project-wide refactor mode
- Advanced agent memory

---

# 🤝 Contributing

We welcome contributions!\
Submit pull requests or issues at:

https://github.com/asepindrak/vibe-coding-extension

---

# 📄 License

MIT License

---

# 📜 Release Notes

## 2.0.2

- Multi Model Support (OpenAI)
- OpenAI API Key (BYOK)
- Coding Agent Improvements
- UI Improvements

## 2.0.1

- 🚀 Major Update: Agent Mode (Autonomous Task Execution)
- 🖼 Added File & Image Upload Support
- 🧠 Step-by-step reasoning system
- 🖥 Terminal command execution
- ✏️ Diff-based file modification

## 1.5.0

- Code Suggestions

## 1.4.x

- Performance improvements
- Streaming AI responses
- API Spec generation
- Token validation improvements

## 1.3.0

- Teach AI Current Code

## 1.2.0

- Generate Full CRUD Pages

## 1.1.x

- Code completions improvements

## 1.0.0

- Initial Release
