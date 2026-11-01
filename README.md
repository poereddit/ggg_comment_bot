# GGGCommentBot
A small Reddit bot for the Path of Exile community. By kjennet, modified by multiplicitypoe

1. Install Python
2. `pip install praw`
3. Create a reddit app [here](https://ssl.reddit.com/prefs/apps/)
   - Name it
   - Select Script from the radio buttons
   - Short Description
   - Redirect URI (I don't think it matters, I just used google)
   - Create App
4. Copy `.env.example` to `.env` and fill in the bot account username and password, the app's client id (under "personal use script"), and the app's secret.
5. Optionally set `SUBREDDIT_NAME` in `.env` (defaults to `pathofexile`). Run a second copy from its own directory with `pathofexile2` to cover r/pathofexile2, since each copy keeps its own state files.
6. Run `python3 GGGRedditBot.py`. The bot keeps its state in `.pickle` files in the working directory.
7. Change any of the other variables at the top of the script you want


