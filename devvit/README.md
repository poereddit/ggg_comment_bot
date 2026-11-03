# ggg-comment-bot (Devvit)

When a Path of Exile employee comments in a thread, this app keeps one stickied comment at the top of the thread listing every employee reply, each with a link and a short snippet. It is a port of the Python bot in [poereddit/ggg_comment_bot](https://github.com/poereddit/ggg_comment_bot), which stops working when Reddit's public API closes.

## Status

Tested on Devvit 0.15.2 in a private test subreddit. Not installed on a live subreddit yet.

## How it works

- `onCommentCreate` checks the author against the roster and, for employees, adds a line to the thread's summary comment.
- A sweep every 10 minutes reads each roster member's recent comments in this subreddit and adds anything the trigger missed. It ignores comments older than a day, so installing the app never touches old threads.
- Once the summary comment passes 7,200 characters it gets the footer, and further lines go in a distinguished reply to it.
- A comment is marked as handled only after Reddit accepts the edit, so a failure is picked up again by the next sweep.
- A short Redis lock per thread stops two comments that arrive together from overwriting each other.
- The roster is a per-subreddit setting (one username per line). Mods can edit it without a redeploy.

## Differences from the Python bot

- Roster matching ignores case.
- No first-run baseline. The one-day limit on the sweep does that job.

## Run the checks

```
npm install
npm test
```
