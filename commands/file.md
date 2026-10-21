---
description: "Send a file to an agent session"
argument-hint: "<address> <path> [message]"
---
Parse $ARGUMENTS as a destination address, a file path (possibly quoted with single or double quotes), and an optional message. Turn the telephone on with action "on" if needed, then call the telephone tool with action "send", to set to the address, files set to an array containing the path, and message set to the remaining text. Never read or paste the file contents into the message.
