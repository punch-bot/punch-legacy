export function isBotDirectlyMentioned(message, botUser) {
  return message.mentions.users.has(botUser.id);
}
