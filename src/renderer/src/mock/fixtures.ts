// Sample catalog for the browser-only mock. Titles are real games; durations are approximate.

export interface FixtureAlbum {
  title: string
  titleOriginal?: string
  kind: 'ost' | 'gamerip' | 'arrange' | 'remix'
  year: number
  composers: string[]
  formats: ('mp3' | 'flac')[]
  tracks: [string, string][]
}

export interface FixtureGame {
  name: string
  original?: string
  year: number
  platforms: string[]
  franchise?: string
  accent: string
  /** Second colour for generated art. */
  accent2: string
  albums: FixtureAlbum[]
}

export const FIXTURE_GAMES: FixtureGame[] = [
  {
    name: 'Chrono Trigger',
    original: 'クロノ・トリガー',
    year: 1995,
    platforms: ['SNES'],
    franchise: 'Chrono',
    accent: '#ff9f43',
    accent2: '#3d2a8a',
    albums: [
      {
        title: 'Chrono Trigger Original Sound Version',
        titleOriginal: 'クロノ・トリガー オリジナル・サウンド・ヴァージョン',
        kind: 'ost',
        year: 1995,
        composers: ['Yasunori Mitsuda', 'Nobuo Uematsu', 'Noriko Matsueda'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Presentiment', '1:20'],
          ['Chrono Trigger', '2:52'],
          ['Morning Sunlight', '1:04'],
          ['Peaceful Days', '2:12'],
          ['Guardia Millennial Fair', '2:55'],
          ['Gato\'s Song', '0:47'],
          ['Yearnings of the Wind', '2:45'],
          ['Secret of the Forest', '3:19'],
          ['Battle', '2:12'],
          ['Frog\'s Theme', '1:57'],
          ['Battle with Magus', '2:51'],
          ['Corridors of Time', '3:38'],
          ['To Far Away Times', '4:42']
        ]
      },
      {
        title: 'Chrono Trigger Arranged Version: The Brink of Time',
        kind: 'arrange',
        year: 1995,
        composers: ['Yasunori Mitsuda', 'Guido'],
        formats: ['mp3'],
        tracks: [
          ['The Brink of Time', '4:46'],
          ['Warp', '2:01'],
          ['Robo\'s Theme', '4:11'],
          ['Tower of Magus', '3:56'],
          ['Wind Scene', '5:37']
        ]
      }
    ]
  },
  {
    name: 'Final Fantasy VI',
    original: 'ファイナルファンタジーVI',
    year: 1994,
    platforms: ['SNES'],
    franchise: 'Final Fantasy',
    accent: '#c56cf0',
    accent2: '#1e2a5a',
    albums: [
      {
        title: 'Final Fantasy VI Original Sound Version',
        kind: 'ost',
        year: 1994,
        composers: ['Nobuo Uematsu'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Omen', '3:58'],
          ['Awakening', '1:38'],
          ['Tina', '3:34'],
          ['Kefka', '2:34'],
          ['The Decisive Battle', '2:47'],
          ['Searching for Friends', '2:48'],
          ['Aria di Mezzo Carattere', '4:12'],
          ['Celes', '2:34'],
          ['Dancing Mad', '11:55']
        ]
      }
    ]
  },
  {
    name: 'Celeste',
    year: 2018,
    platforms: ['Windows', 'Switch'],
    accent: '#ff5f9e',
    accent2: '#2b1d5c',
    albums: [
      {
        title: 'Celeste Original Soundtrack',
        kind: 'ost',
        year: 2018,
        composers: ['Lena Raine'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Prologue', '2:02'],
          ['First Steps', '4:28'],
          ['Resurrections', '6:44'],
          ['Awake', '4:49'],
          ['Checking In', '4:30'],
          ['Spirit of Hospitality', '4:09'],
          ['Scattered and Lost', '5:40'],
          ['Golden', '4:58'],
          ['Reach for the Summit', '6:29'],
          ['Confronting Myself', '3:51'],
          ['Exhale', '4:54']
        ]
      },
      {
        title: 'Celeste: Farewell',
        kind: 'ost',
        year: 2019,
        composers: ['Lena Raine'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Farewell', '5:21'],
          ['Say Goodbye', '3:28']
        ]
      }
    ]
  },
  {
    name: 'Hollow Knight',
    year: 2017,
    platforms: ['Windows', 'Switch'],
    accent: '#7fb3ff',
    accent2: '#0e1426',
    albums: [
      {
        title: 'Hollow Knight Original Soundtrack',
        kind: 'ost',
        year: 2017,
        composers: ['Christopher Larkin'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Enter Hallownest', '1:51'],
          ['Dirtmouth', '2:26'],
          ['Crossroads', '3:12'],
          ['False Knight', '2:28'],
          ['Greenpath', '3:00'],
          ['Hornet', '2:55'],
          ['City of Tears', '3:59'],
          ['Dung Defender', '3:09'],
          ['Mantis Lords', '3:22'],
          ['Sealed Vessel', '4:24'],
          ['Radiance', '4:12']
        ]
      }
    ]
  },
  {
    name: 'NieR:Automata',
    original: 'ニーア オートマタ',
    year: 2017,
    platforms: ['PS4', 'Windows'],
    franchise: 'NieR',
    accent: '#e8dcc0',
    accent2: '#2a2620',
    albums: [
      {
        title: 'NieR:Automata Original Soundtrack',
        kind: 'ost',
        year: 2017,
        composers: ['Keiichi Okabe', 'Keigo Hoashi', 'Kuniyuki Takahashi'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['City Ruins - Rays of Light', '6:07'],
          ['Amusement Park', '5:51'],
          ['Weight of the World', '5:42'],
          ['Bipolar Nightmare', '5:09'],
          ['Vague Hope', '4:43'],
          ['The Tower', '6:29'],
          ['Birth of a Wish', '4:56'],
          ['Pascal', '4:23']
        ]
      }
    ]
  },
  {
    name: 'Persona 5',
    original: 'ペルソナ5',
    year: 2016,
    platforms: ['PS4', 'PS3'],
    franchise: 'Persona',
    accent: '#ff2d3a',
    accent2: '#120a0a',
    albums: [
      {
        title: 'Persona 5 Original Soundtrack',
        kind: 'ost',
        year: 2017,
        composers: ['Shoji Meguro'],
        formats: ['mp3'],
        tracks: [
          ['Wake Up, Get Up, Get Out There', '4:43'],
          ['Beneath the Mask', '4:38'],
          ['Last Surprise', '3:57'],
          ['Life Will Change', '4:48'],
          ['Rivers in the Desert', '4:57'],
          ['Layer Cake', '3:14'],
          ['Blooming Villain', '3:41'],
          ['Butterfly Kiss', '2:43']
        ]
      }
    ]
  },
  {
    name: 'Outer Wilds',
    year: 2019,
    platforms: ['Windows', 'PS4', 'Xbox One'],
    accent: '#ffb86b',
    accent2: '#0b1e33',
    albums: [
      {
        title: 'Outer Wilds Original Soundtrack',
        kind: 'ost',
        year: 2019,
        composers: ['Andrew Prahlow'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Timber Hearth', '2:44'],
          ['Outer Wilds', '2:39'],
          ['The Museum', '1:39'],
          ['Travelers', '4:08'],
          ['The Nomai', '2:01'],
          ['End Times', '2:44'],
          ['14.3 Billion Years', '4:33']
        ]
      }
    ]
  },
  {
    name: 'Undertale',
    year: 2015,
    platforms: ['Windows'],
    accent: '#ffd23f',
    accent2: '#140f25',
    albums: [
      {
        title: 'Undertale Soundtrack',
        kind: 'ost',
        year: 2015,
        composers: ['Toby Fox'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Once Upon a Time', '1:28'],
          ['Start Menu', '1:17'],
          ['Fallen Down', '0:58'],
          ['Ruins', '1:31'],
          ['Snowdin Town', '1:16'],
          ['Bonetrousle', '0:56'],
          ['Waterfall', '2:08'],
          ['Spear of Justice', '1:55'],
          ['Hopes and Dreams', '3:02'],
          ['Megalovania', '2:36'],
          ['Death by Glamour', '2:14']
        ]
      }
    ]
  },
  {
    name: 'Sonic the Hedgehog 3',
    year: 1994,
    platforms: ['Genesis'],
    franchise: 'Sonic the Hedgehog',
    accent: '#3fa2ff',
    accent2: '#0a2a14',
    albums: [
      {
        title: 'Sonic the Hedgehog 3 (Gamerip)',
        kind: 'gamerip',
        year: 1994,
        composers: ['Jun Senoue', 'Howard Drossin'],
        formats: ['mp3'],
        tracks: [
          ['Angel Island Zone Act 1', '1:52'],
          ['Hydrocity Zone Act 2', '2:01'],
          ['Marble Garden Zone Act 1', '1:44'],
          ['Carnival Night Zone Act 1', '1:58'],
          ['IceCap Zone Act 1', '2:46'],
          ['Launch Base Zone Act 1', '2:10'],
          ['Boss', '1:13']
        ]
      }
    ]
  },
  {
    name: 'Hades',
    year: 2020,
    platforms: ['Windows', 'Switch'],
    accent: '#ff4f3a',
    accent2: '#1a0b14',
    albums: [
      {
        title: 'Hades Original Soundtrack',
        kind: 'ost',
        year: 2020,
        composers: ['Darren Korb'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['No Escape', '2:34'],
          ['The House of Hades', '3:14'],
          ['Out of Tartarus', '3:02'],
          ['The Painful Way', '3:21'],
          ['Mouth of Styx', '3:49'],
          ['God of the Dead', '4:18'],
          ['Good Riddance', '4:02'],
          ['In the Blood', '4:58']
        ]
      }
    ]
  },
  {
    name: 'Super Mario Galaxy',
    original: 'スーパーマリオギャラクシー',
    year: 2007,
    platforms: ['Wii'],
    franchise: 'Super Mario',
    accent: '#9b7bff',
    accent2: '#081032',
    albums: [
      {
        title: 'Super Mario Galaxy Original Soundtrack',
        kind: 'ost',
        year: 2007,
        composers: ['Mahito Yokota', 'Koji Kondo'],
        formats: ['mp3', 'flac'],
        tracks: [
          ['Overture', '2:51'],
          ['Egg Planet', '2:44'],
          ['Comet Observatory', '2:30'],
          ['Gusty Garden Galaxy', '2:57'],
          ['Buoy Base Galaxy', '2:41'],
          ['Bowser\'s Galaxy Reactor', '3:16'],
          ['Final Battle with Bowser', '3:24']
        ]
      }
    ]
  },
  {
    name: 'Katamari Damacy',
    original: '塊魂',
    year: 2004,
    platforms: ['PS2'],
    franchise: 'Katamari',
    accent: '#4cd964',
    accent2: '#ff3b8b',
    albums: [
      {
        title: 'Katamari Fortissimo Damacy',
        kind: 'ost',
        year: 2004,
        composers: ['Yu Miyake', 'Akitaka Tohyama'],
        formats: ['mp3'],
        tracks: [
          ['Overture', '0:31'],
          ['Katamari on the Rocks', '5:30'],
          ['Wanda Wanda', '3:55'],
          ['Lonely Rolling Star', '4:52']
        ]
      }
    ]
  },
  {
    name: 'Metroid Prime',
    year: 2002,
    platforms: ['GameCube'],
    franchise: 'Metroid',
    accent: '#ff8a2a',
    accent2: '#0a1b2e',
    albums: [
      {
        title: 'Metroid Prime & Fusion Original Soundtracks',
        kind: 'ost',
        year: 2004,
        composers: ['Kenji Yamamoto', 'Kouichi Kyuma'],
        formats: ['mp3'],
        tracks: [
          ['Title', '2:12'],
          ['Tallon Overworld', '3:57'],
          ['Chozo Ruins', '3:54'],
          ['Phendrana Drifts', '4:36'],
          ['Magmoor Caverns', '3:46'],
          ['Meta Ridley', '2:24'],
          ['Metroid Prime Battle', '3:12']
        ]
      }
    ]
  }
]
