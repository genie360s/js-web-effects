// What each video shows and says. One entry per package: a title card, then
// `run(s)` drives the demo while captions explain what is happening under it.
// `s` is the stage from record-videos.mjs; coordinates are CSS pixels in a
// 1920×1080 viewport.
export const storyboards = {
  'web-fire': {
    title: 'web fire',
    tagline: 'Set fire to a web page. A combustion solver, not a shader that looks like fire.',
    start: '#/text',
    poster: 14,
    async run(s) {
      await s.say('Drag across the page to hold a match to it. The page is the fuel: its alpha is read back as a fuel map, so only the ink burns.')
      await s.drag([[640, 420], [900, 392], [1290, 410]], 2200)
      await s.wait(1500)
      await s.drag([[1250, 545], [960, 520], [670, 548]], 1800)
      await s.wait(2000)
      await s.say('Above about 800 K the surface gives off vapour, and the vapour burns where it meets oxygen, all the way up the plume.',
        ['fuel map', 'Rust → WebAssembly solver, on a worker', 'heat, soot, char', 'WebGL2 shader'])
      await s.drag([[770, 700], [960, 690], [1160, 702]], 1600)
      await s.wait(5500)

      await s.go('#/image')
      await s.say('Hot gas rises. The air cannot be compressed, so fresh oxygen is pulled in at the base, and that is what keeps the flame alive.')
      await s.drag([[690, 770], [960, 790], [1230, 768]], 2200)
      await s.wait(7000)

      await s.go('#/video')
      await s.say('Video keeps playing while it burns. The colour is not painted: it is Planck’s law for a body at that temperature.')
      await s.drag([[680, 660], [960, 675], [1250, 655]], 2000)
      await s.wait(6000)

      await s.go('#/login')
      await s.say('Under the flames it is still a working page. The form keeps its focus and what you typed.')
      await s.click(960, 489)
      await s.type('hello@example.com')
      await s.wait(600)
      await s.drag([[800, 700], [960, 690], [1130, 705]], 1800)
      await s.wait(5500)
    },
  },

  'box-tiles-fx': {
    title: 'box tiles',
    tagline: 'The grid from a title sequence, for the web.',
    start: '',
    poster: 12,
    async run(s) {
      await s.page.keyboard.press('h') // the demo's own dials would sit under the captions
      await s.say('A fine grid sits over the picture. On their own time the tiles misbehave: one goes black, one shows the picture from a few cells away, one flares up.')
      await s.wait(4200)
      await s.say('The pointer excites the tiles around it, and a click knocks the whole grid.')
      await s.path([[520, 300], [900, 520], [1400, 300], [1620, 680], [1050, 800], [640, 480]], 5200)
      await s.click(1150, 430)
      await s.wait(1300)
      await s.click(760, 620)
      await s.wait(1500)
      await s.say('The grid is a state machine with a clock: written in Rust, compiled to WebAssembly, stepped on a worker thread.',
        ['pointer or beat', 'Rust → WebAssembly grid, on a worker', '4 numbers per tile', 'WebGL2 shader'])
      await s.path([[1000, 300], [1500, 480], [1250, 760], [800, 640], [1100, 420]], 5000)
      await s.wait(800)

      await s.go('#/titles', 1400)
      await s.say('A title sequence from the same parts. Names arrive through the grid tile by tile and leave the same way, on the clip’s own clock.')
      await s.wait(10500)

      await s.go('#/login')
      await s.say('Whatever is under the grid stays real DOM. This form keeps its focus, its typing and its submit while it is tiled.')
      await s.click(960, 489)
      await s.type('hello@example.com')
      await s.path([[820, 420], [1100, 520], [900, 660], [1120, 700]], 3200)
      await s.wait(900)

      await s.go('#/all')
      await s.say('Text, components, images and playing video are all layers on the GPU, and each layer chooses whether the grid touches it.')
      await s.path([[380, 620], [760, 480], [1100, 640], [1500, 500], [1200, 380], [700, 340]], 5500)
      await s.click(1000, 560)
      await s.wait(1600)
    },
  },

  'web-sand': {
    title: 'web-sand',
    tagline: 'Beach sand for the web. Run a stick through it.',
    start: 'index.html',
    poster: 12,
    async run(s) {
      await s.say('Move the cursor and the grains under it are pushed aside, piled along the rim of the groove, and left to slump until nothing stands steeper than sand can stand.')
      await s.path([[1000, 300], [1320, 240], [1620, 400], [1520, 640], [1220, 700], [1010, 560], [1260, 440]], 5200)
      await s.wait(1000)
      await s.say('The beach is a height field, simulated in Rust and compiled to a 22 KB WebAssembly module. Hold the button and the stick presses in deeper.',
        ['stick', 'Rust → WebAssembly grains', 'one height texture', 'WebGL2 lighting'])
      await s.drag([[900, 850], [1200, 770], [1500, 860], [1760, 750]], 3200)
      await s.wait(700)
      await s.path([[1300, 520], [1100, 440], [780, 410], [420, 440]], 3000)
      await s.wait(1500)

      await s.go('text.html')
      await s.say('Text and components lie on the sand. They slide when the sand under them moves, and disappear under the sand pushed over them.')
      await s.path([[540, 510], [900, 492], [1390, 520]], 2800)
      await s.path([[1200, 640], [1180, 752], [960, 740], [740, 760]], 2600)
      await s.wait(1600)

      await s.go('colour.html')
      await s.say('Stir through anything and its colour lifts off into the grains and smears along wherever you drag it.')
      await s.path([[560, 640], [760, 705], [900, 620], [1080, 712], [1240, 630], [1380, 700], [1500, 830], [1200, 870], [800, 850]], 5600)
      await s.wait(1400)

      await s.go('video.html')
      await s.say('Images and playing video go straight to the GPU and are bent by the same field, frame after frame.')
      await s.path([[640, 500], [960, 620], [1280, 520], [1100, 740], [760, 700]], 4800)
      await s.wait(1800)
    },
  },

  'web-tear': {
    title: 'web-tear',
    tagline: 'Tearable interfaces. Pages of cloth you take hold of and pull.',
    start: 'index.html',
    poster: 16,
    async run(s) {
      await s.say('Every page here is a sheet of cloth. Nudge it and it stretches and springs back; pull gently and it only folds.')
      await s.drag([[1300, 700], [1350, 740], [1380, 770]], 800)
      await s.wait(1300)
      await s.drag([[720, 640], [800, 730], [860, 800]], 1300)
      await s.wait(1700)
      await s.say('Pull firmly and the paper gives way where the strain concentrates. Keep dragging and the tear runs along your hand.')
      await s.drag([[520, 300], [800, 500], [1200, 700], [1600, 900]], 3000)
      await s.wait(700)
      await s.drag([[1500, 250], [1200, 500], [800, 750], [420, 950]], 3000)
      await s.wait(900)
      await s.say('The cloth is a mesh with tensile strength, simulated in Rust and WebAssembly inside a Web Worker. Nothing simulates on the main thread.',
        ['page HTML', 'sheet texture', 'Rust → WebAssembly cloth, on a worker', 'WebGL2'])
      await s.drag([[960, 160], [980, 520], [900, 1000]], 2600)
      await s.wait(500)
      await s.drag([[300, 600], [900, 630], [1700, 560]], 2600)
      await s.wait(2200)

      await s.go('both.html', 1500)
      await s.say('Photographs and playing video tear with the paper they sit on. Tear through the photograph to reach the video behind it.')
      await s.drag([[600, 250], [900, 520], [1300, 820]], 2800)
      await s.wait(600)
      await s.drag([[1400, 220], [1000, 520], [560, 880]], 2800)
      await s.wait(600)
      await s.drag([[960, 200], [1000, 600], [940, 1040]], 2400)
      await s.wait(3000)
    },
  },

  'web-oil-colours': {
    title: 'web-oil-colours',
    tagline: 'Wet oil paint in the browser, mixed the way pigment mixes.',
    start: '#/studio',
    poster: 12,
    async run(s) {
      await s.say('Move the cursor and the wet paint moves with it. Colours mix the way pigment does: each cell stores how the paint absorbs and scatters light, never RGB.')
      await s.path([[700, 560], [950, 650], [1200, 740], [1500, 800], [1760, 840]], 3600)
      await s.path([[1500, 700], [1100, 600], [720, 520], [450, 420]], 3600)
      await s.wait(900)
      await s.say('Oil paint only flows above a yield stress. That is why the ridges a brush leaves stay standing, and why the canvas comes to rest.',
        ['brush', 'Rust → WebAssembly pigment solver, on a worker', 'thickness + pigment', 'WebGL2 lighting'])
      await s.click(48, 141)
      await s.drag([[600, 260], [900, 200], [1250, 290], [1520, 220]], 3000)
      await s.click(219, 141)
      await s.drag([[520, 900], [850, 820], [1200, 930], [1620, 860]], 3000)
      await s.wait(1500)

      await s.go('#/oil-colour-ui', 1500)
      await s.say('Mark an element with v-oil and its surface is laid into the pigment field as real paint. The form still works, and the cursor can smear it.')
      await s.path([[700, 420], [960, 470], [1220, 430]], 2600)
      await s.path([[1230, 600], [960, 640], [720, 610]], 2600)
      await s.wait(1800)

      await s.go('#/oil-media', 1500)
      await s.say('A photograph becomes paint too. Thickness is a real height field, so the shader lights actual ridges and furrows.')
      await s.path([[500, 400], [900, 520], [1300, 380], [1600, 620], [1200, 820], [700, 700]], 6000)
      await s.wait(1800)
    },
  },

  'web-water': {
    title: 'still water',
    tagline: 'An interactive pond, and an interface that floats in it.',
    start: '#/pond',
    poster: 20,
    async run(s) {
      await s.say('Move slowly and the pointer sheds ripples. The surface is a damped wave equation, solved in Rust and WebAssembly on a worker thread.')
      await s.path([[600, 500], [800, 620], [1050, 560], [1250, 650]], 6000)
      await s.wait(600)
      await s.say('Drive it fast and it stops being a point poking the surface: a V-shaped wake opens up behind it.')
      await s.path([[300, 820]], 900)
      await s.path([[1700, 300]], 1000)
      await s.wait(1300)
      await s.path([[1500, 850], [300, 400]], 1300)
      await s.wait(1800)
      await s.say('Click and a stone drops in. The bed of silt, stones and leaves is generated at runtime, and seen through the water: refraction, caustics, absorption.',
        ['pointer', 'Rust → WebAssembly wave solver, on a worker', 'height field', 'WebGL2 optics'])
      await s.click(700, 450)
      await s.wait(1000)
      await s.click(1250, 620)
      await s.wait(1000)
      await s.click(960, 300)
      await s.wait(3000)

      await s.go('#/water-ui', 1500)
      await s.say('An interface under water. The panel is painted into a layer the shader sees through the surface, so ripples bend it, and its controls drive the water they float in.')
      await s.drag([[960, 555], [1040, 556], [1110, 555]], 1500)
      await s.wait(900)
      await s.click(867, 702)
      await s.wait(1800)
      await s.path([[620, 420], [960, 300], [1360, 450], [1300, 820], [700, 830]], 4200)
      await s.click(867, 702)
      await s.wait(3000)
    },
  },
}
