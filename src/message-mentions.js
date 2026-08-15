/**
 * True when the bot appears in explicit @user mentions only.
 * Discord.js `message.mentions.has(bot)` is also true for @here / @everyone.
 */
export function isBotDirectlyMentioned(message, botUser) {
  return message.mentions.users.has(botUser.id);
}
