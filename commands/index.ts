import { generalCommands } from './general.ts';
import { vipCommands } from './vip.ts';
import { groupCommands } from './group.ts';
import { mediaCommands } from './media.ts';
import { ownerCommands } from './owner.ts';
import type { BotCommand } from './types.ts';

const allCommands: BotCommand[] = [
  ...generalCommands,
  ...vipCommands,
  ...groupCommands,
  ...mediaCommands,
  ...ownerCommands,
];

const commandMap = new Map<string, BotCommand>();
for (const cmd of allCommands) {
  commandMap.set(cmd.name.toLowerCase(), cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commandMap.set(alias.toLowerCase(), cmd);
    }
  }
}

export function getAllCommands(): BotCommand[] {
  return allCommands;
}

export function findCommand(name: string): BotCommand | undefined {
  return commandMap.get(name.toLowerCase());
}
