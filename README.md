# better-diff
normal diff too much. what if diffs were tldrs i can zoom in and out of

## concept
code review has been getting harder with the volume of code to go through due to ai assisted code generation (its a good thing only)
looking at diffs kind of became pointless. raw diffs as it is i mean.

you might have come across issues like these
- large diff block and its just formatter things, but interleaved with important small changes that i might miss
- i have to jump around multiple parts of the diff since diffs are alpahbetically ordered by file name, not diff blocks by the execution flow they appear
- fatigue creeps in by just seeing a 2000 line change to comb through

i have to aggressviely prioritize what i should go over and what i can just skim through these days
i have to zoom in on things that need scrutiny but brush over things that are arbitary

so something i did at work is:
1. i treat each diff block as my unit  
<img width="500" height="984" alt="cleanshot 2026-04-16 at 15 11 37@2x" src="https://github.com/user-attachments/assets/c2bdedc0-a90f-440a-80be-fac173d86570" />

2. i take diffs and get the llm to rearrange it in the execution / data flow order. (it splits up blocks within the files as well)  
<img width="500" height="1006" alt="cleanshot 2026-04-16 at 15 12 12@2x" src="https://github.com/user-attachments/assets/520fab22-a49b-486f-a687-cd325d01ee74" />

3. then i get a one liner description for each of the diff like "formatter changed" "anthropic key changed to openrouter"  
<img width="500" height="636" alt="cleanshot 2026-04-16 at 15 13 03@2x" src="https://github.com/user-attachments/assets/3aa60edd-d454-4f75-878c-e7228c56f5b9" />

4. and then i get a pr level or natural language description of the entire diff  
<img width="500" height="296" alt="cleanshot 2026-04-16 at 15 13 30@2x" src="https://github.com/user-attachments/assets/033a2149-5510-4b6f-95d4-3090d15f16e9" />  

5. and read it all the way from the bottom to top, so that i go from the least information to detail as i need

i jump in and out out of my summaries, natural lang diffs, rearranged diffs, and the raw diffs. 

this is the core idea, and i wanted this as a core primtive in my code editor / agent workspace. the old diff view just feels slow to work with.

in an ideal world i can blindly rely on the ai you wouldnt need this
but in places where its no there yet, i felt like there needs to be a middle ground, and i think this is it.

this wasnt possible before this general intelligence being available.
reordering diff blocks require some intelligence. 
converting them into natural language defo.
making a flexible tldr of that, yeah.

cant this be just a skill, i think most things could be represented by a instruction and a text output.
there is a seamless in and out experience i wanted and how it integrates with other system
text could represent this but i think its too inefficient of a representation and is too much detail for me to handle at once
i like boxes hiding away detail from me

## dev flow
- we used codex for the most part obvs. 
- we primarily worked on top of this ui : https://github.com/jakemor/kanna which works with codex app server part of codex cli installed locally.
- here is a dummy we built to test if the diff viewer works : https://github.com/AlferdMurray/yt-spotify-migrations
- what we implemented is extending the diff viewer to have the the phases, the llm part of it is all via the same app server.

### how to run this
1. have bun
2. do bun install
3. bun install
4. bun run dev
5. load up your project run something and check the diff out