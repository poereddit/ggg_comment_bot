import os
import praw
import pickle
import re
import time
from datetime import datetime

# Load KEY=VALUE pairs from a .env file next to this script into the environment
def load_env(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')):
    try:
        with open(path) as env_file:
            for line in env_file:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"\''))
    except FileNotFoundError:
        pass

# Debug flag (True if running for testing purposes, False if running for production)
debug = False

# START VARIABLES #
# APP Variables and Login Information (set in .env, see .env.example)
load_env()
user_agent_string = os.environ.get('REDDIT_USER_AGENT', 'PoE GGG Bot')
account_username = os.environ.get('REDDIT_USERNAME')
account_password = os.environ.get('REDDIT_PASSWORD')
client_id_string = os.environ.get('REDDIT_CLIENT_ID')
client_secret_string = os.environ.get('REDDIT_CLIENT_SECRET')

missing = [name for name, value in (('REDDIT_USERNAME', account_username),
                                    ('REDDIT_PASSWORD', account_password),
                                    ('REDDIT_CLIENT_ID', client_id_string),
                                    ('REDDIT_CLIENT_SECRET', client_secret_string)) if not value]
if missing:
    raise SystemExit('Missing environment variables: ' + ', '.join(missing) + ' (see .env.example)')

# Setup and Use Variables
subreddit_name = os.environ.get('SUBREDDIT_NAME', 'pathofexile')                          # Subreddit (sets subreddit to parse)
my_comments_file = "my_comments.pickle"                 # Location for Bot Comment Links per Submission
last_comments_file = "last_comments.pickle"             # Location for Username of Last GGG post in Submission
connect_timeout = 10                                    # Timeout delay (in seconds) before next connection attempt
snippet_word_count = 30                                 # Snippet Word Count (number of words to include in snippet)
context_depth = 10                                       # Permalink will provide context by showing parents of this many levels up from the linked comment
ts_format = '%I:%M%p %m/%d/%y UTC'                      # Timestamp format string (for more info => https://docs.python.org/2/library/datetime.html#strftime-and-strptime-behavior)

# Format string for header of section
# {name} - comment author
def header_string_format():
    return '##### GGG Comments in this Thread:\n\n***'

# Create a snippet of a comment
# comment - reddit comment object
# word_count - number of words to create, specified by variable snippet_word_count
def create_snippet(comment, word_count):
    body = re.sub(r'!\[[^\]]*\]\([^)]*\)', '(gif)', comment.body)  # replace embedded media (e.g. ![gif](giphy|..), uploaded images/emotes) which Reddit rejects when nested in our comment
    word_list = body.split()                            # split (sanitized) comment body
    snippet = str.join(' ', word_list[0:word_count])    # join from 0 to max of word_count (by whitespace) words in list
    if (len(word_list) > word_count):                   # add ... to end of snippet if snippet contains 10 words, but list contained more
        snippet = snippet + '...'
    return snippet or '(gif)'                            # never return empty (media-only comments)

# Format string for each post
# {time} - Formatted Timestamp
# {comment_link} - Everything after the reddit.com in the url
# {comment_author} - Name of the comment author
# {text_snippet} - Snippet of Comment using snippet_word_count words
# {full_comment_text} - The full comment text for use in hover previews
# {context_depth} - Number of parent comments up to show
def line_string_format():
    # return '\n\n[{name} - [link](https://www.reddit.com{comment_link}?context={context_depth} "{full_comment_text}"), [old](https://old.reddit.com{comment_link}?context={context_depth} "{full_comment_text}")] - *{text_snippet}*\n\n'
    return '\n\n[{name} - [link](https://www.reddit.com{comment_link}?context={context_depth}), [old](https://old.reddit.com{comment_link}?context={context_depth})] - *{text_snippet}*\n\n'

def footer_string_format():
    return '\n\n Normally, I would break here due to too many replies, but this bot is now Bex Proof! Continued below...'


# List of GGG Employees --- TODO NEEDS UPDATED
ggg_emps = [
    'Kelly_GGG',
    'Community_Team',
    'chris_wilson',
    'Bex_GGG',
    'Negitivefrags',
    'Rory_Rackham',
    'Omnitect',
    'Mark_GGG',
    'Daniel_GGG',
    'Blake_GGG',
    'RhysGGG',
    'Dan_GGG',
    'pantherNZ',
    'AlexDenfordGGG',
    'M59Gar',
    'Novynn',
    'Fitzy_GGG',
    'Hrishi_GGG',
    'Felipe_GGG',
    'Mel_GGG',
    'Sarah_GGG',
    'riandrake',
    'Kieren_GGG',
    'Hartlin_GGG',
    'Baltic_GGG',
    'KamilOrmanJanowski',
    'Jeff_GGG',
    'Stacey_GGG',
    'Openarl',
    'Natalia_GGG',
    'Natalia2_GGG',
    'viperesque',
    'ZaccieA',
    'Henry_GGG',
    'Nick_GGG',
    'Neon_GGG',
    'Belakay_ggg',
    'MatthewD_GGG',
]

if (debug):
    subreddit_name = ''                                 # Debugging Subreddit
    ggg_emps = []                                       # Debugging List of Users
    my_comments_file = "debug_comments.pickle"          # Debugging Stored Comments of Bot
    last_comments_file = "debug_last.pickle"            # Debugging Last Comment of Bot

# Load Data from file
def load_submissions(file):
    submissions = {}                                    # setup variables
    file_in = None                                      # for try/except
    try:
        file_in = open(file, "rb")                      # open file as read binary
        submissions = pickle.load(file_in)              # load data into dictionary
    except:
        if (debug):
            print('catch all read error')
    finally:
        if (file_in):                                   # if file_in exists, close file
            file_in.close()
        return submissions

# Save Data to file
def save_submissions(item, file):
    success = True                                      # Setup variables
    file_out = None                                     # for try/except
    try:
        file_out = open(file, "wb")                     # open file as write binary
        pickle.dump(item, file_out)                     # dump data to file
    except:
        if (debug):
            print('Failed to save')
        success = False                                 # Failed to write successfully
    finally:
        if (file_out):                                  # If file, close it.
            file_out.close()
        return success                                  # Return success status

my_comments = load_submissions(my_comments_file)        # Load bot actions
last_comments = load_submissions(last_comments_file)    # Load Last GGG Comment Data

#################################################################################
#                                                                               #
#                       Connect to Reddit through praw                          #
#                                                                               #
#################################################################################

reddit = praw.Reddit(user_agent=user_agent_string,
                     client_id=client_id_string,
                     client_secret=client_secret_string,
                     username=account_username,
                     password=account_password)

subreddit = reddit.subreddit(subreddit_name)                                        # connect to specified subreddit
print('Started bot')
# count = 1                                                                         # variable for counting parsed comments

def newGGGComment(comment):
    myReply = None                                                                  # Variable to store comment object of the bot's latest reply
    edit = False                                                                    # Flag for whether or not bot is editing a comment or posting a new one
    newSelfReply = False                                                            # Flag if the bot should post a new reply underneath the old one because it has hit the chat limit
    link = comment.submission                                                       # get submission object comment is attributed to
    if (link.id in my_comments):                                                    # If bot has responded to submission
        edit = True                                                                 # Set edit flag to true
        myReply = reddit.comment(my_comments[link.id])                              # Get the comment to edit 
        if (len(myReply.body) > 7200):                                              # Checks if current comment associated with post is full
            newSelfReply = True                                                     # If there is a footer, it will post the new comment in reply to itself instead of a top level comment
            edit = False
            if footer_string_format() not in myReply.body:                          # If no footer, add it and recurse
                new_body = myReply.body + footer_string_format()
                myReply.edit(new_body)
                newGGGComment(comment)
                return
    snippet = create_snippet(comment, snippet_word_count)                           # create snippet of text from comment, with snippet_word_count words
    timestamp = datetime.utcfromtimestamp(comment.created_utc).strftime(ts_format)  # format time from comment timestamp according to ts_format string
                                                                                    # Create line text from line_string_format and passed in variables
    line = line_string_format().format(name=comment.author.name,
                                        comment_link = comment.permalink,
                                        comment_author = comment.author.name,
                                        text_snippet = snippet,
                                        context_depth = context_depth)
    
    header = header_string_format()
    if (edit):                                                                      # If editing bot comment already in thread
        new_body = myReply.body + line
        myReply.edit(new_body)                                                      
    else:                                                                           # If not editing, we post a new comment.
        r = None
        if newSelfReply:                                                            # If this is true, we reply to ourselves instead of the thread
            r = myReply.reply(header + line)
            r.mod.distinguish()
        else:                                                                       # Else, reply to thread and sticky
            r = link.reply(header + line)                                           # Reply to link with header + line + footer
            r.mod.distinguish(sticky=True)
        my_comments[link.id] = r.id                                                 # Set bot comment to this submission ID to be the new reply (always updated to be the latest comment if replying to itself)
        save_submissions(my_comments, my_comments_file)                             # Save the updated dictionary
    last_comments[link.id] = comment.author.name                                    # Set GGG last comment username to be current comment username
    save_submissions(last_comments, last_comments_file)                             # Save updated dictionary

# Discovery configuration
# Instead of praw's comment stream (which silently drops comments during high-volume
# bursts, and skips everything posted during a reconnect when using skip_existing=True),
# we poll two sources and de-duplicate against a persistent seen-set so nothing is
# missed and nothing is aggregated twice:
#   1. subreddit.comments(limit=100)      -> low latency for the common case
#   2. each GGG employee's own history    -> guarantee: a single user's comment history
#                                            never overflows from subreddit volume or a
#                                            reconnect gap, so we always catch it eventually
processed_file = "processed_" + subreddit_name + ".pickle"  # Persistent set of handled comment ids (per subreddit)
poll_interval = 15                                          # Seconds between primary newest-comment polls
backfill_interval = 300                                     # Seconds between full employee-history safety sweeps
history_limit = 25                                          # Employee comments to scan per sweep
max_seen = 20000                                            # Cap on remembered comment ids (bounds memory/pickle size)

# Load the seen-set (stored as an ordered list so we can trim the oldest ids)
seen_list = load_submissions(processed_file)                # Returns {} on first run (no file yet)
first_run = not isinstance(seen_list, list)                 # {} (default) means we have never run with the new format
if first_run:
    seen_list = []
seen = set(seen_list)

# Remember a comment id as handled and persist it, trimming the oldest ids past max_seen
def remember(comment_id):
    if comment_id in seen:
        return
    seen.add(comment_id)
    seen_list.append(comment_id)
    if len(seen_list) > max_seen:
        old = seen_list.pop(0)
        seen.discard(old)
    save_submissions(seen_list, processed_file)

# Handle one comment: skip if already seen; otherwise, if a GGG employee wrote it,
# aggregate it. record_only=True seeds the baseline on first run without replying,
# so we don't re-aggregate comments that were already handled before this restart.
# Only GGG comments are remembered -- the seen-set stays small and never evicts an id
# that an employee-history backfill could still surface (which would double-post).
def handle(comment, record_only=False):
    if comment is None or comment.id in seen:
        return
    author = comment.author.name if comment.author else None                        # author is None for deleted/removed accounts
    if author not in ggg_emps:                                                      # only care about GGG employees; ignore everyone else
        return
    if not record_only:
        now = datetime.now()
        print('Found GGG comment to reply to at {}: /u/{}'.format(now, author), flush=True)
        newGGGComment(comment)
    remember(comment.id)                                                            # remember only handled GGG comments

# On first run, mark everything currently visible as seen (without replying) so the bot
# only acts on comments that appear from now on -- matching the old skip_existing=True behaviour.
if first_run:
    print('First run: seeding baseline seen-set...', flush=True)
    try:
        for comment in subreddit.comments(limit=100):
            handle(comment, record_only=True)
        for emp in ggg_emps:
            try:
                for comment in reddit.redditor(emp).comments.new(limit=history_limit):
                    handle(comment, record_only=True)
            except Exception as e:
                if '404' not in str(e):                                              # 404 = account gone/renamed; skip quietly
                    print('Baseline seed failed for /u/{}: {}'.format(emp, e), flush=True)
                continue
    except Exception as e:
        print('Baseline seed error: {}'.format(e), flush=True)
    print('Seeded baseline with {} comment ids'.format(len(seen)), flush=True)

print('Started bot (polling mode) on r/{}'.format(subreddit_name), flush=True)
last_backfill = 0.0                                                                  # Force a full employee sweep on the first iteration
while True:                                                                          # main loop to keep bot running
    try:
        # 1. Primary pass: newest comments in the subreddit (low latency)
        for comment in subreddit.comments(limit=100):
            try:
                handle(comment)
            except Exception as e:
                print('Failed handling comment {}: {}'.format(getattr(comment, 'id', '?'), e), flush=True)
                continue
        # 2. Safety-net pass: scan each GGG employee's own recent history so a comment
        #    dropped by a firehose burst or a reconnect gap is still caught.
        if time.time() - last_backfill >= backfill_interval:
            for emp in ggg_emps:
                try:
                    for comment in reddit.redditor(emp).comments.new(limit=history_limit):
                        if str(comment.subreddit).lower() == subreddit_name.lower():  # only this subreddit; ignore their comments elsewhere
                            handle(comment)
                except Exception as e:
                    if '404' not in str(e):                                          # 404 = account gone/renamed; skip quietly
                        print('Backfill failed for /u/{}: {}'.format(emp, e), flush=True)
                    continue
            last_backfill = time.time()
    except Exception as e:
        print('Had an error: {}'.format(e), flush=True)
        time.sleep(connect_timeout)                                                 # On connection failure, wait before retrying (no comments are skipped: the seen-set persists)
        continue
    time.sleep(poll_interval)                                                        # Pause between polls to stay within rate limits
