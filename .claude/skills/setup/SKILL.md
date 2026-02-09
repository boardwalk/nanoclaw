---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Telegram bot, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (scanning QR codes).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoClaw needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** NanoClaw automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**
```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 4. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build succeeded by running a simple test (this auto-detects which runtime you're using):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 5. Configure Telegram Bot

Tell the user:
> You need to create a Telegram bot to use as your assistant.
>
> 1. Open Telegram and message [@BotFather](https://t.me/BotFather)
> 2. Send `/newbot` to create a new bot
> 3. Choose a name for your bot (e.g., "My Assistant")
> 4. Choose a username (must end in "bot", e.g., "myassistant_bot")
> 5. BotFather will give you an API token
>
> Paste the bot token here and I'll add it to `.env` for you.

Wait for the user to provide the token, then add it to `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=<token>" >> .env
```

Verify:
```bash
grep "^TELEGRAM_BOT_TOKEN=" .env && echo "Bot token configured" || echo "Missing bot token"
```

## 6. Configure Assistant Name and Main Channel

This step configures three things at once: the trigger word, the main channel type, and the main channel selection.

### 6a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> In Telegram group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally private chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

### 6b. Explain security model and ask about main channel type

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use your private chat with the bot (DM) as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Private chat with bot (DM) - Recommended
> 2. Telegram group (I understand the security implications)

If they choose option 2, ask a follow-up:

> You've chosen a Telegram group. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
> - Read messages from your other registered chats
> - Schedule and manage tasks
> - Access any directories you've mounted
>
> Options:
> 1. Yes, I understand and want to proceed
> 2. No, let me use a personal chat or solo group instead

### 6c. Get Chat ID

Tell the user:
> To get your chat ID, send the `/chatid` command to your bot in the chat you want to use as your main channel.
>
> For a **private chat**: Open Telegram, search for your bot, and send `/chatid`
> For a **group**: Add your bot to the group, then send `/chatid` in the group
>
> The bot will reply with the chat ID. Paste it here.

Wait for the user to provide the chat ID. It will be a number (e.g., `123456789` for users, or negative like `-1001234567890` for groups).

The JID format is `tg:{chatId}` (e.g., `tg:123456789` or `tg:-1001234567890`).

### 6d. Write the configuration

Once you have the chat ID, configure it. Use the assistant name from step 6a and construct the JID as `tg:{chatId}`.

For private chats (option 1 - no prefix needed), set `requiresTrigger` to `false`:

```bash
mkdir -p data
cat > data/registered_groups.json << EOF
{
  "tg:CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")",
    "requiresTrigger": false
  }
}
EOF
```

For groups (option 2), set `requiresTrigger` to `true`:

```bash
mkdir -p data
cat > data/registered_groups.json << EOF
{
  "tg:CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")",
    "requiresTrigger": true
  }
}
EOF
```

If the user chose a name other than `Andy`, also update:
1. `groups/global/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top

Ensure the groups folder exists:
```bash
mkdir -p groups/main/logs
```

## 7. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 7a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 7b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other Telegram chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 7c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app" }
>   ]
> }
> ```
> The folder appears inside the container at `/workspace/extra/<folder-name>` (derived from the last segment of the path). Add `"readonly": false` for write access, or `"containerPath": "custom-name"` to override the default name.

## 8. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 9. Test

Tell the user (using the assistant name they configured):
> Send a message to your bot in your registered chat.
>
> - If you configured a **private chat** with `requiresTrigger: false`, just send `hello`
> - If you configured a **group** with `requiresTrigger: true`, send `@ASSISTANT_NAME hello`

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in Telegram.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Main channel with `requiresTrigger: false` doesn't need a prefix — all messages are processed
- Check that the chat JID is in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Verify bot token is set: `grep TELEGRAM_BOT_TOKEN .env`
- Check `logs/nanoclaw.log` for errors

**Telegram connection issues**:
- Verify the bot token is correct
- Check that the bot hasn't been deleted in @BotFather
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
