# Vibe Coding (VICO) - 404 Stress Not Found!

Vibe Coding is a chat extension with an assistant designed to help you while programming.

![Vibe Coding Logo](media/vibe-coding-logo.png)
![Vibe Coding SS 1](media/vibe-coding-ss-1.png)
![Vibe Coding SS 2](media/vibe-coding-ss-2.png)

## Features

**Programming Assistance**  
Get help with coding problems, syntax errors, and best practices.

**Interactive Chat**  
Communicate with Vibe Coding in real-time. Ask questions and receive instant responses.

**Select Code to AI**  
Easily select code snippets and ask Vibe Coding for explanations, debugging help, or improvements directly.

**Continue the Code Based on the Provided Comment with Shift+Enter Key**  
Effortlessly extend your code by leveraging the AI's understanding of your comments to generate relevant and context-aware code snippets that follow your intended logic and requirements.  
👉 Press `Shift+Enter` after a comment in your code.

**Code Suggestions / Code Completions**  
Context-aware code snippets that follow your intended logic and requirements.  
👉 Press `Shift+Enter+.` after your code.

**Generate Full CRUD Pages from Model Schema**  
Automatically generate complete frontend components (Form, List, Detail, Schema, Action) from a simple model description.  
- Just ask: *"Generate model Goat with field: id, name, age, breed"*
- Vibe Coding will guide you to complete the schema.
- Once complete, it generates ready-to-use TypeScript and React files.
- Files are saved directly into your project under `src/models/<model-name>/`.

**Teach AI Current Code 🔄**  
This feature allows you to train the AI with a sampled subset of the code in your workspace. By doing so, the AI gains a better understanding of the context, structure, and logic of your code. This helps the AI provide more accurate and relevant suggestions, explanations, and completions tailored to your specific project.
Note: Only a sampled subset of files is used, not the full project.

> ✅ Files generated:
> - `model.schema.ts` (Zod validation)
> - `ModelForm.tsx` (React form)
> - `ModelList.tsx` (Table/list view)
> - `ModelDetailView.tsx` (Detail page)
> - `model.action.ts` (API calls)

---

## Upcoming Features

- **Backend Code Generation**: Extend generation to backend (controllers, routes, services).
- **Custom Templates**: Let users define their own file templates for generation.

---

## Installation

1. **Install the Extension**: Open Visual Studio Code, go to the Extensions view by clicking the Extensions icon in the Activity Bar on the side of the window, or select `View` → `Extensions`.
2. **Search for Vibe Coding**: Type `Vibe Coding` in the search box.
3. **Install**: Click the `Install` button on the Vibe Coding extension from the Marketplace.
4. **Activate**: Once installed, activate the extension by clicking on the Vibe Coding icon in the sidebar.

---

## Usage

1. **Open the Chat**: Click on the Vibe Coding icon in the sidebar to open the chat window.
2. **Login**: Click on the Vibe Coding icon, and log in to start using the assistant.
3. **Start Chatting**: Type your questions or messages, and Vibe Coding will respond.
4. **Get Assistance**: Ask coding-related questions, debugging help, or request code generation.
5. **Generate a Model/Page**:
   - Example prompt: *"Create a GoatCategory model with fields: name (string), createdAt (date)"*
   - The AI will ensure the schema is complete.
   - Once complete, the AI generates the file and the extension creates it in your project.
   - Check the folder: `src/models/goatCategory/`
6. **Generate an API SPEC**:
   - Example prompt: *"Generate API Spec from this ERD:"* (create ERD/DB Diagram from this website https://dbdiagram.io/, then copy & paste the ERD text)
   - The AI will ensure the ERD is complete.
   - Once complete, the AI generates the API Spec

---

## Contributing

We welcome contributions! Please feel free to submit pull requests or issues on our [GitHub repository](https://github.com/asepindrak/vibe-coding-extension).

---

## License

This extension is licensed under the MIT License. See the LICENSE file for details.

---

## Release Notes

### 1.4.5
- Up version & update changelog

### 1.4.4
- Stream AI responses in real time to the chat
- Replace autocomplete trigger with snippet insertion in presentSuggestions function

### 1.4.3
- Updated Webhook URL

### 1.4.1
- Rename to Vibe Coding - VICO

### 1.4.0
- Generate API Spec (Postman) from ERD/DB Diagram

### 1.3.1
- Add token validation logic and update sidebar HTML content
- Implemented token validation in the SidebarProvider class.
- Combined userId with workspacePath to generate a unique token.
- Added logic to check if the provided token matches the generated token.
- Updated global state with the new token upon validation.
- Enhanced HTML content replacement to include logo navigation path.


### 1.3.0
- **feat**: Teach AI Current Code 🔄

### 1.2.2
- **fix**: Confirm overwrite when generating file

### 1.2.1
- **fix**: New training code base & redesign

### 1.2.0
- **feat**: Generate Full CRUD Pages from Model Schema

### 1.1.2
- **fix**: code completions with `Ctrl+Shift+.`

### 1.1.0
- **feat**: code completions

### 1.0.1
- **fix**: update button styles and text in login and logout functionality

### 1.0.0
- **Initial Release**: Vibe Coding.