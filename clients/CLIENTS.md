# Client Testing Status

This directory contains cloned cliente repositories for testing OpenClaw integration.
**Do not commit these folders.**

## Cloned Clients

### Open WebUI (Can be used to create a Docker instance for this project and/or testing. Do not re-clone it for the project, use this clone.)
- **Path**: `clawproxy/clients/open-webui`
- **Repo**: [https://github.com/open-webui/open-webui](https://github.com/open-webui/open-webui)
- **Status**: Cloned.
- **Notes**: Use for testing Chat and Model selection.

#### Docker Quick Start
To run OpenWebUI in a container connected to your local ClawProxy:

1. Run the following command from this directory:
   ```bash
   docker compose -f docker-compose.openwebui.yml up -d
   ```
2. Open [http://localhost:3000](http://localhost:3000).
3. The connection to ClawProxy (`http://host.docker.internal:8080/v1`) is pre-configured.


### SillyTavern
- **Path**: `clawproxy/clients/SillyTavern`
- **Repo**: [https://github.com/SillyTavern/SillyTavern](https://github.com/SillyTavern/SillyTavern)
- **Status**: Cloned.
- **Notes**: Good for testing complex prompts and character cards.

## Non-Clonable Clients

### LM Studio
- **Type**: Desktop Application (Closed Source)
- **Status**: Not cloned.
- **Notes**: Must be installed manually by the user.