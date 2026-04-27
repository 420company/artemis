# Artemis — AI assistant CLI by www.420.company

Artemis is a CLI AI assistant that supports multiple AI models and provides an interactive chat interface with Vibe Coding capabilities.

## Features

- **Multiple AI Models**: Support for OpenAI, Claude, and other models
- **Vibe Coding**: Intelligent code generation with context awareness
- **Real-time Search**: Wikipedia and DuckDuckGo search integration without API key configuration
- **Conversation Context**: Maintains conversation history and context
- **User Preferences**: Customizable user profile and model preferences
- **Batch Mode**: Run scripts and workflows from files

## Installation

```bash
npm install -g artemis
```

## Usage

### Start a Chat Session

```bash
artemis chat --model <model-name> --api-key <api-key>
```

### Command-line Options

- `--model`: AI model to use (e.g., `gpt-4`, `claude-3`)
- `--api-key`: API key for the selected model
- `--file`: Run a script file in batch mode
- `--batch`: Enable batch processing mode
- `--version`: Show version information
- `--help`: Show help information

## Search Functionality

Artemis supports real-time search capabilities:

### Wikipedia Search

Direct Wikipedia API access with no API key required.

### DuckDuckGo Search

Web search using DuckDuckGo's HTML interface with no API key required.

### Auto-detect Backend

Automatically detects available search backends and falls back to Wikipedia if DuckDuckGo fails.

## Vibe Coding

Vibe Coding is Artemis's intelligent code generation feature. It supports:

- Function calling
- Code review
- Design generation
- Architecture planning

## Configuration

Configuration is stored in `~/.config/artemis/config.json`. You can customize:

- Default model
- API key storage
- Search backend preferences
- User profile information

## Development

To develop Artemis locally:

1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run tests: `npm run test`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see LICENSE file for details