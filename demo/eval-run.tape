# VHS tape — records a short GIF of the eval suite scoring the agent.
# Regenerate with:  vhs demo/eval-run.tape   (run from the repo root; needs Docker infra up)
Output demo/screenshots/eval-run.gif

Set Shell "zsh"
Set FontSize 13
Set Width 1200
Set Height 880
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# Land in the repo with a clean screen (not part of the recording).
Hide
Type "cd /Users/rahulbhardwaj/Documents/Personal/Projects/agentrie && clear"
Enter
Sleep 500ms
Show

# The actual recorded bit: type it, run it, pause on the result.
Type "npm run eval -- run seed"
Sleep 800ms
Enter
Sleep 6s
