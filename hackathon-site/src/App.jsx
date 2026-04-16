import './App.css'

const painPoints = [
  'large diff block and its just formatter things, but interleaved with important small changes that i might miss',
  'i have to jump around multiple parts of the diff since diffs are alphabetically ordered by file name, not diff blocks by the execution flow they appear',
  'fatigue creeps in by just seeing a 2000 line change to comb through',
]

const workflow = [
  {
    step: '1',
    title: 'i treat each diff block as my unit',
    description:
      'instead of treating the file as the thing to review, i treat each diff block as the thing i can inspect, skim, or ignore.',
    image:
      'https://github.com/user-attachments/assets/c2bdedc0-a90f-440a-80be-fac173d86570',
  },
  {
    step: '2',
    title: 'i get the llm to rearrange it in execution / data flow order',
    description:
      'it splits up blocks within the files as well, so the thing i read starts to match how the change actually unfolds.',
    image:
      'https://github.com/user-attachments/assets/520fab22-a49b-486f-a687-cd325d01ee74',
  },
  {
    step: '3',
    title: 'i get a one liner description for each diff',
    description:
      'things like "formatter changed" or "anthropic key changed to openrouter" are enough for me to know what needs scrutiny.',
    image:
      'https://github.com/user-attachments/assets/3aa60edd-d454-4f75-878c-e7228c56f5b9',
  },
  {
    step: '4',
    title: 'i get a pr level or natural language description of the entire diff',
    description:
      'so i can start from the whole shape of the change and only drop into detail when i actually need to.',
    image:
      'https://github.com/user-attachments/assets/033a2149-5510-4b6f-95d4-3090d15f16e9',
  },
  {
    step: '5',
    title: 'and then i read it all the way from the bottom to top',
    description:
      'so that i go from the least information to detail as i need. i jump in and out of summaries, natural lang diffs, rearranged diffs, and the raw diffs.',
  },
]

function HeroDoodles() {
  return (
    <div className="hero-doodles" aria-hidden="true">
      {/* diff block sketch */}
      <svg className="doodle doodle-diff" width="140" height="110" viewBox="0 0 140 110" fill="none">
        <rect x="4" y="4" width="132" height="102" rx="6" stroke="currentColor" strokeWidth="1.5" strokeDasharray="6 4" />
        <line x1="12" y1="24" x2="60" y2="24" stroke="currentColor" strokeWidth="1.3" />
        <line x1="12" y1="38" x2="90" y2="38" stroke="currentColor" strokeWidth="1.3" />
        <text x="14" y="56" fill="#5a7" fontSize="14" fontFamily="inherit">+ added line</text>
        <text x="14" y="74" fill="#e66" fontSize="14" fontFamily="inherit">- removed line</text>
        <line x1="12" y1="88" x2="75" y2="88" stroke="currentColor" strokeWidth="1.3" />
      </svg>

      {/* magnifying glass */}
      <svg className="doodle doodle-magnify" width="72" height="72" viewBox="0 0 72 72" fill="none">
        <circle cx="30" cy="30" r="18" stroke="currentColor" strokeWidth="1.8" />
        <line x1="43" y1="43" x2="62" y2="62" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <text x="22" y="34" fill="currentColor" fontSize="14" fontFamily="inherit">?</text>
      </svg>

      {/* curly braces */}
      <svg className="doodle doodle-braces" width="48" height="100" viewBox="0 0 48 100" fill="none">
        <path d="M28 6C18 6 14 16 14 26C14 36 8 42 4 50C8 58 14 64 14 74C14 84 18 94 28 94" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <path d="M36 6C46 6 48 16 48 26C48 36 44 42 40 50C44 58 48 64 48 74C48 84 46 94 36 94" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.5" />
      </svg>

      {/* plus minus signs */}
      <svg className="doodle doodle-plusminus" width="56" height="56" viewBox="0 0 56 56" fill="none">
        <line x1="14" y1="14" x2="42" y2="14" stroke="#5a7" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="28" y1="2" x2="28" y2="26" stroke="#5a7" strokeWidth="2.5" strokeLinecap="round" />
        <line x1="14" y1="44" x2="42" y2="44" stroke="#e66" strokeWidth="2.5" strokeLinecap="round" />
      </svg>

      {/* file icon */}
      <svg className="doodle doodle-file" width="52" height="64" viewBox="0 0 52 64" fill="none">
        <path d="M6 4H34L46 18V58C46 60 44 62 42 62H10C8 62 6 60 6 58V4Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M34 4V18H46" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <line x1="14" y1="30" x2="38" y2="30" stroke="currentColor" strokeWidth="1.2" />
        <line x1="14" y1="40" x2="32" y2="40" stroke="currentColor" strokeWidth="1.2" />
        <line x1="14" y1="50" x2="36" y2="50" stroke="currentColor" strokeWidth="1.2" />
      </svg>

      {/* little arrow loop */}
      <svg className="doodle doodle-loop" width="64" height="48" viewBox="0 0 64 48" fill="none">
        <path d="M8 38C8 14 56 14 56 38" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <path d="M48 32L56 38L48 44" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  )
}

function SectionDoodle({ type = 'brackets', className = '' }) {
  const doodles = {
    brackets: (
      <svg width="40" height="60" viewBox="0 0 40 60" fill="none">
        <path d="M14 4C8 4 6 12 6 20C6 28 3 32 2 36C3 40 6 44 6 52C6 58 8 56 14 56" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      </svg>
    ),
    hash: (
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <line x1="12" y1="4" x2="10" y2="32" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="24" y1="4" x2="22" y2="32" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="4" y1="14" x2="32" y2="12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <line x1="4" y1="24" x2="32" y2="22" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
    eye: (
      <svg width="52" height="28" viewBox="0 0 52 28" fill="none">
        <path d="M4 14C10 4 42 4 48 14C42 24 10 24 4 14Z" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <circle cx="26" cy="14" r="5" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    ),
  }

  return (
    <div className={`section-doodle ${className}`} aria-hidden="true">
      {doodles[type]}
    </div>
  )
}

function SketchArrow({ rotate = 0, flip = false }) {
  return (
    <div
      className="sketch-arrow"
      style={{
        transform: `rotate(${rotate}deg)${flip ? ' scaleX(-1)' : ''}`,
      }}
    >
      <svg width="48" height="80" viewBox="0 0 48 80" fill="none">
        <path
          d="M24 4C22 18 20 32 22 46C23 54 25 62 24 70"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 60C20 66 23 72 24 76C25 72 28 66 32 60"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}

function App() {
  return (
    <main className="page">
      <header className="topbar">
        <a className="brand" href="#intro">
          better-diff
        </a>
        <nav className="nav">
          <a href="#intro">Intro</a>
          <a href="#demos">Demos</a>
          <a href="#details">Details</a>
          <a href="#wrap-up">Wrap Up</a>
        </nav>
      </header>

      <section className="hero section" id="intro">
        <HeroDoodles />
        <p className="eyebrow">better-diff</p>
        <h1>
          normal diff too much.
          <br />
          what if diffs were{' '}
          <span className="marker"><span className="shout">TLDR</span>s</span>
          <br />
          i can <span className="zoom-in">zoom in</span> and{' '}
          <span className="zoom-out">zoom out</span> of
        </h1>
      </section>

      <section className="section">
        <p className="intro-body">
          code review has been getting harder with the volume of code to go
          through due to ai assisted code generation (its a good thing only).
          looking at diffs kind of became pointless. raw diffs as it is i mean.
        </p>
      </section>

      <section className="section statement">
        <p>
          i have to aggressively prioritize what i should go over and what i
          can just skim through these days
        </p>
      </section>

      <SketchArrow rotate={-3} />

      <section className="section narrow has-doodle" id="details">
        <SectionDoodle type="hash" className="float-right" />
        <p className="eyebrow">you might have come across issues like these</p>
        <ul className="pain-list">
          {painPoints.map((item) => (
            <li className="pain-item" key={item}>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section className="section statement large">
        <p>
          i have to <span className="zoom-in">zoom in</span> on things that
          need scrutiny but brush over things that are arbitrary
        </p>
      </section>

      <SketchArrow rotate={4} flip />

      <section className="section narrow" id="demos">
        <p className="eyebrow">so something i did at work is</p>
      </section>

      <section className="workflow">
        {workflow.map((item, i) => (
          <article className="demo-block" key={item.step}>
            <div className="demo-copy">
              <h2>
                {item.step}. {item.title}
              </h2>
              <p>{item.description}</p>
            </div>
            {item.image ? (
              <div className="demo-media">
                <img src={item.image} alt="" loading="lazy" />
              </div>
            ) : null}
            {i < workflow.length - 1 && (
              <SketchArrow
                rotate={i % 2 === 0 ? -2 : 3}
                flip={i % 3 === 1}
              />
            )}
          </article>
        ))}
      </section>

      <SketchArrow rotate={-1} />

      <section className="section narrow has-doodle">
        <SectionDoodle type="eye" className="float-left" />
        <p className="eyebrow">this is the core idea</p>
        <h2>
          i wanted this as a core primitive in my code editor / agent workspace
        </h2>
        <p className="body-copy">
          the old diff view just feels slow to work with.
        </p>
        <ol className="zoom-stack">
          <li>pr level description</li>
          <li>natural lang diffs</li>
          <li>reordered diff blocks</li>
          <li>raw diffs</li>
        </ol>
      </section>

      <section className="section narrow has-doodle">
        <SectionDoodle type="brackets" className="float-right" />
        <p className="eyebrow">middle ground</p>
        <h2>
          in an ideal world i can blindly rely on the ai you wouldnt need this
        </h2>
        <p className="body-copy">
          but in places where its not there yet, i felt like there needs to be a
          middle ground, and i think this is it.
        </p>
        <p className="body-copy">
          this wasnt possible before this general intelligence being available.
        </p>
      </section>

      <section className="section statement">
        <p>
          reordering diff blocks require some intelligence.
          <br />
          converting them into natural language defo.
          <br />
          making a flexible tldr of that, yeah.
        </p>
      </section>

      <SketchArrow rotate={2} flip />

      <section className="section wrap-up" id="wrap-up">
        <p className="eyebrow">wrap up</p>
        <h2>
          text could represent this but i think its too inefficient of a
          representation and is too much detail for me to handle at once
        </h2>
        <p className="body-copy">
          i like boxes hiding away detail from me.
        </p>
      </section>

      <footer className="footer-nav">
        <a href="#intro">Intro</a>
        <a href="#demos">Demos</a>
        <a href="#details">Details</a>
        <a href="#wrap-up">Wrap Up</a>
      </footer>
    </main>
  )
}

export default App
