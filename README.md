# ggg-comment-bot (Devvit)

When a Path of Exile employee comments in a thread, this app keeps one stickied comment at the top of the thread listing every employee reply, each with a link and a short snippet. It is a port of the Python bot in [poereddit/ggg_comment_bot](https://github.com/poereddit/ggg_comment_bot), which stops working when Reddit's public API closes.

## Status

Written and tested locally. Never run on Devvit. Needs `devvit login` and a playtest before anything else.

What is checked: types compile, the snippet and line formats match the Python bot on 300+ random inputs, and the append logic (create, edit, full-comment chaining, two comments arriving together, a deleted summary, a failed Reddit call) passes against in-memory fakes of Redis and the Reddit API.

What is not checked, and needs a playtest in a test subreddit:
- The app account can sticky and distinguish its own comment (`distinguish(true)` after `submitComment`).
- The cron task in `devvit.json` is scheduled on install.
- `onCommentCreate` delivers `comment.author`, `comment.permalink` and `comment.postId` as the types say.
- The 24 hour limit on the sweep behaves on a real employee account.

## How it works

- `onCommentCreate` checks the author against the roster and, for employees, adds a line to the thread's summary comment.
- A sweep every 10 minutes reads each roster member's recent comments in this subreddit and adds anything the trigger missed. It ignores comments older than a day, so installing the app never touches old threads.
- Once the summary comment passes 7,200 characters it gets the footer, and further lines go in a distinguished reply to it.
- A comment is marked as handled only after Reddit accepts the edit, so a failure is picked up again by the next sweep.
- A short Redis lock per thread stops two comments that arrive together from overwriting each other.
- The roster is a per-subreddit setting (one username per line). Mods can edit it without a redeploy.

## Differences from the Python bot

- Comments come from the app's account, not u/GGGCommentBot. Existing summary comments stay under the old account and are not edited.
- Roster matching ignores case.
- No first-run baseline. The one-day limit on the sweep does that job.

## Run the checks

```
npm install
npm test
```
