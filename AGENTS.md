<!-- LOVABLE:BEGIN -->

> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

<!-- LOVABLE:END -->

- Keep the voice transport in the supplied useLiveVoice hook and persistent server relay so microphone cleanup and paid-session heartbeats remain unified.
- Store voice transcript fragments as owner-scoped records and authenticate the relay before loading memory or starting paid sessions.
- Keep the home screen public with sign-in required only for calling and saved conversation access.
