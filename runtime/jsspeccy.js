import EventEmitter from 'events';
import fileDialog from 'file-dialog';
import JSZip from 'jszip';
import Translator from '@andreasremdt/simple-translator';

import { DisplayHandler } from './render.js';
import { UIController } from './ui.js';
import { parseSNAFile, parseZ80File, parseSZXFile } from './snapshot.js';
import { TAPFile, TZXFile } from './tape.js';
import { KeyboardHandler } from './keyboard.js';
import { AudioHandler } from './audio.js';

import openIcon from './icons/open.svg';
import resetIcon from './icons/reset.svg';
import playIcon from './icons/play.svg';
import pauseIcon from './icons/pause.svg';
import fullscreenIcon from './icons/fullscreen.svg';
import exitFullscreenIcon from './icons/exitfullscreen.svg';

import enTranslation from './i18n/en.json';
import esTranslation from './i18n/es.json';

const scriptUrl = document.currentScript.src;

class Emulator extends EventEmitter {
    constructor(canvas, opts) {
        super();
        this.canvas = canvas;
        this.worker = new Worker(new URL('jsspeccy-worker.js', scriptUrl));
        this.keyboardHandler = new KeyboardHandler(this.worker);
        this.displayHandler = new DisplayHandler(this.canvas);
        this.audioHandler = new AudioHandler();
        this.isRunning = false;
        this.isInitiallyPaused = (!opts.autoStart);
        this.autoLoadTapes = opts.autoLoadTapes || false;
        this.tapeAutoLoadMode = opts.tapeAutoLoadMode || 'default'; // or usr0

        this.setPalette(opts.palette || 0);

        this.msPerFrame = 20;

        this.isExecutingFrame = false;
        this.nextFrameTime = null;
        this.machineType = null;

        this.nextFileOpenID = 0;
        this.fileOpenPromiseResolutions = {};

        this.worker.onmessage = (e) => {
            switch (e.data.message) {
                case 'ready':
                    this.loadRoms().then(() => {
                        this.setMachine(opts.machine || 128);
                        if (opts.openUrl) {
                            this.openUrlList(opts.openUrl).catch(err => {
                                alert(err);
                            }).then(() => {
                                if (opts.autoStart) this.start();
                            });
                        } else if (opts.autoStart) {
                            this.start();
                        }
                    });
                    break;
                case 'frameCompleted':
                    // benchmarkRunCount++;
                    if ('audioBufferLeft' in e.data) {
                        this.audioHandler.frameCompleted(e.data.audioBufferLeft, e.data.audioBufferRight);
                    }

                    this.displayHandler.frameCompleted(e.data.frameBuffer);
                    if (this.isRunning) {
                        const time = performance.now();
                        if (time > this.nextFrameTime) {
                            /* running at full blast - start next frame but adjust time base
                            to give it the full time allocation */
                            this.runFrame();
                            this.nextFrameTime = time + this.msPerFrame;
                        } else {
                            this.isExecutingFrame = false;
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
                    break;
                case 'fileOpened':
                    if (e.data.mediaType == 'tape' && this.autoLoadTapes) {
                        const TAPE_LOADERS_BY_MACHINE = {
                            '48': { 'default': 'tapeloaders/tape_48.szx', 'usr0': 'tapeloaders/tape_48.szx' },
                            '128': { 'default': 'tapeloaders/tape_128.szx', 'usr0': 'tapeloaders/tape_128_usr0.szx' },
                            '5': { 'default': 'tapeloaders/tape_pentagon.szx', 'usr0': 'tapeloaders/tape_pentagon_usr0.szx' },
                        };
                        this.openUrl(new URL(TAPE_LOADERS_BY_MACHINE[this.machineType][this.tapeAutoLoadMode], scriptUrl));
                    }
                    this.fileOpenPromiseResolutions[e.data.id]({
                        mediaType: e.data.mediaType,
                    });
                    break;
                default:
                    console.log('message received by host:', e.data);
            }
        }
        this.worker.postMessage({
            message: 'loadCore',
            baseUrl: scriptUrl,
        })
    }

    start() {
        if (!this.isRunning) {
            this.isRunning = true;
            this.isInitiallyPaused = false;
            this.nextFrameTime = performance.now();
            this.keyboardHandler.start();
            this.audioHandler.start();
            this.emit('start');
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    }

    pause() {
        if (this.isRunning) {
            this.isRunning = false;
            this.keyboardHandler.stop();
            this.audioHandler.stop();
            this.emit('pause');
        }
    }

    async loadRom(url, page) {
        const response = await fetch(new URL(url, scriptUrl));
        const data = new Uint8Array(await response.arrayBuffer());
        this.worker.postMessage({
            message: 'loadMemory',
            data,
            page: page,
        });
    }

    async loadRoms() {
        await this.loadRom('roms/128-0.rom', 8);
        await this.loadRom('roms/128-1.rom', 9);
        await this.loadRom('roms/48.rom', 10);
        await this.loadRom('roms/pentagon-0.rom', 12);
        await this.loadRom('roms/trdos.rom', 13);
    }


    runFrame() {
        this.isExecutingFrame = true;
        const frameBuffer = this.displayHandler.getNextFrameBuffer();

        if (this.audioHandler.isActive) {
            const [audioBufferLeft, audioBufferRight] = this.audioHandler.frameBuffers;

            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
                audioBufferLeft,
                audioBufferRight,
            }, [frameBuffer, audioBufferLeft, audioBufferRight]);
        } else {
            this.worker.postMessage({
                message: 'runFrame',
                frameBuffer,
            }, [frameBuffer]);
        }
    }

    runAnimationFrame(time) {
        if (this.displayHandler.readyToShow()) {
            this.displayHandler.show();
            // benchmarkRenderCount++;
        }
        if (this.isRunning) {
            if (time > this.nextFrameTime && !this.isExecutingFrame) {
                this.runFrame();
                this.nextFrameTime += this.msPerFrame;
            }
            window.requestAnimationFrame((t) => {
                this.runAnimationFrame(t);
            });
        }
    };

    getPalette() {
        return this.displayHandler.paletteSelection;
    }

    setPalette(palette) {
        this.displayHandler.setPalette(palette);
        this.emit('setPalette', this.displayHandler.paletteSelection);
    }

    setMachine(type) {
        if (type != 128 && type != 5) type = 48;
        this.worker.postMessage({
            message: 'setMachineType',
            type,
        });
        this.machineType = type;
        this.emit('setMachine', type);
    }

    reset() {
        this.worker.postMessage({ message: 'reset' });
    }

    loadSnapshot(snapshot) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'loadSnapshot',
            id: fileID,
            snapshot,
        })
        this.emit('setMachine', snapshot.model);
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTAPFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTAPFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    openTZXFile(data) {
        const fileID = this.nextFileOpenID++;
        this.worker.postMessage({
            message: 'openTZXFile',
            id: fileID,
            data,
        })
        return new Promise((resolve, reject) => {
            this.fileOpenPromiseResolutions[fileID] = resolve;
        });
    }

    getFileOpener(filename) {
        const cleanName = filename.toLowerCase();
        if (cleanName.endsWith('.z80')) {
            return arrayBuffer => {
                const z80file = parseZ80File(arrayBuffer);
                return this.loadSnapshot(z80file);
            };
        } else if (cleanName.endsWith('.szx')) {
            return arrayBuffer => {
                const szxfile = parseSZXFile(arrayBuffer);
                return this.loadSnapshot(szxfile);
            };
        } else if (cleanName.endsWith('.sna')) {
            return arrayBuffer => {
                const snafile = parseSNAFile(arrayBuffer);
                return this.loadSnapshot(snafile);
            };
        } else if (cleanName.endsWith('.tap')) {
            return arrayBuffer => {
                if (!TAPFile.isValid(arrayBuffer)) {
                    alert('Invalid TAP file');
                } else {
                    return this.openTAPFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.tzx')) {
            return arrayBuffer => {
                if (!TZXFile.isValid(arrayBuffer)) {
                    alert('Invalid TZX file');
                } else {
                    return this.openTZXFile(arrayBuffer);
                }
            };
        } else if (cleanName.endsWith('.zip')) {
            return async arrayBuffer => {
                const zip = await JSZip.loadAsync(arrayBuffer);
                const openers = [];
                zip.forEach((path, file) => {
                    if (path.startsWith('__MACOSX/')) return;
                    const opener = this.getFileOpener(path);
                    if (opener) {
                        const boundOpener = async() => {
                            const buf = await file.async('arraybuffer');
                            return opener(buf);
                        };
                        openers.push(boundOpener);
                    }
                });
                if (openers.length == 1) {
                    return openers[0]();
                } else if (openers.length == 0) {
                    throw 'No loadable files found inside ZIP file: ' + filename;
                } else {
                    // TODO: prompt to choose a file
                    throw 'Multiple loadable files found inside ZIP file: ' + filename;
                }
            }
        }
    }

    async openFile(file) {
        const opener = this.getFileOpener(file.name);
        if (opener) {
            const buf = await file.arrayBuffer();
            return opener(buf).catch(err => { alert(err); });
        } else {
            throw 'Unrecognised file type: ' + file.name;
        }
    }

    async openUrl(url) {
        const opener = this.getFileOpener(url.toString());
        if (opener) {
            const response = await fetch(url);
            const buf = await response.arrayBuffer();
            return opener(buf);
        } else {
            throw 'Unrecognised file type: ' + url.split('/').pop();
        }
    }
    async openUrlList(urls) {
        if (typeof(urls) === 'string') {
            return await this.openUrl(urls);
        } else {
            for (const url of urls) {
                await this.openUrl(url);
            }
        }
    }

    setAutoLoadTapes(val) {
        this.autoLoadTapes = val;
        this.emit('setAutoLoadTapes', val);
    }

    exit() {
        this.pause();
        this.worker.terminate();
    }
}

window.JSSpeccy = (container, opts) => {
    // let benchmarkRunCount = 0;
    // let benchmarkRenderCount = 0;
    opts = opts || {};

    opts.sandbox = opts.sandbox || false;
    opts.language = opts.language || 'en';

    const translator = new Translator({
        defaultLanguage: 'en'
    });
    translator.add('en', enTranslation).add('es', esTranslation);

    let langs = new Set(['en', 'es']);
    if (!langs.has(opts.language.toLowerCase())) opts.language = 'en';

    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;

    const emu = new Emulator(canvas, {
        machine: opts.machine || 128,
        palette: opts.palette || 0,
        autoStart: opts.autoStart || false,
        autoLoadTapes: opts.autoLoadTapes || false,
        tapeAutoLoadMode: opts.tapeAutoLoadMode || 'default',

        openUrl: opts.openUrl,
    });
    const ui = new UIController(container, emu, { zoom: opts.zoom || 1, sandbox: opts.sandbox });

    if (!opts.sandbox) {
        const fileMenu = ui.menuBar.addMenu(translator.translateForKey('fileMenu.file', opts.language));
        fileMenu.addItem(translator.translateForKey('fileMenu.open', opts.language), () => {
            openFileDialog();
        });
        const autoLoadTapesMenuItem = fileMenu.addItem(translator.translateForKey('fileMenu.autoLoadTapes', opts.language), () => {
            emu.setAutoLoadTapes(!emu.autoLoadTapes);
        });

        const updateAutoLoadTapesCheckbox = () => {
            if (emu.autoLoadTapes) {
                autoLoadTapesMenuItem.setCheckbox();
            } else {
                autoLoadTapesMenuItem.unsetCheckbox();
            }
        }
        emu.on('setAutoLoadTapes', updateAutoLoadTapesCheckbox);
        updateAutoLoadTapesCheckbox();

        fileMenu.addItem(translator.translateForKey('fileMenu.findGames', opts.language), () => {
            openGameBrowser();
        });
    }

    if (!opts.sandbox) {
        const machineMenu = ui.menuBar.addMenu(translator.translateForKey('machineMenu.machine', opts.language));
        const machine48Item = machineMenu.addItem(translator.translateForKey('machineMenu.spectrum48', opts.language), () => {
            emu.setMachine(48);
        });
        const machine128Item = machineMenu.addItem(translator.translateForKey('machineMenu.spectrum128', opts.language), () => {
            emu.setMachine(128);
        });
        const machinePentagonItem = machineMenu.addItem(translator.translateForKey('machineMenu.pentagon', opts.language), () => {
            emu.setMachine(5);
        });

        emu.on('setMachine', (type) => {
            if (type == 48) {
                machine48Item.setBullet();
                machine128Item.unsetBullet();
                machinePentagonItem.unsetBullet();
            } else if (type == 128) {
                machine48Item.unsetBullet();
                machine128Item.setBullet();
                machinePentagonItem.unsetBullet();
            } else { // pentagon
                machine48Item.unsetBullet();
                machine128Item.unsetBullet();
                machinePentagonItem.setBullet();
            }
        });

    }

    const displayMenu = ui.menuBar.addMenu(translator.translateForKey('displayMenu.display', opts.language));

    const zoomItemsBySize = {
        1: displayMenu.addItem(translator.translateForKey('displayMenu.zoom100%', opts.language), () => ui.setZoom(1)),
        2: displayMenu.addItem(translator.translateForKey('displayMenu.zoom200%', opts.language), () => ui.setZoom(2)),
        3: displayMenu.addItem(translator.translateForKey('displayMenu.zoom300%', opts.language), () => ui.setZoom(3)),
    }
    const fullscreenItem = displayMenu.addItem(translator.translateForKey('displayMenu.fullscreen', opts.language), () => {
        ui.enterFullscreen();
    })
    const setZoomCheckbox = (factor) => {
        if (factor == 'fullscreen') {
            fullscreenItem.setBullet();
            for (let i in zoomItemsBySize) {
                zoomItemsBySize[i].unsetBullet();
            }
        } else {
            fullscreenItem.unsetBullet();
            for (let i in zoomItemsBySize) {
                if (parseInt(i) == factor) {
                    zoomItemsBySize[i].setBullet();
                } else {
                    zoomItemsBySize[i].unsetBullet();
                }
            }
        }
    }
    ui.on('setZoom', setZoomCheckbox);
    setZoomCheckbox(ui.zoom);

    const paletteMenu = ui.menuBar.addMenu(translator.translateForKey('paletteMenu.palette', opts.language));
    const paletteSelection = {
        0: paletteMenu.addItem(translator.translateForKey('paletteMenu.default', opts.language), () => emu.setPalette(0)),
        1: paletteMenu.addItem(translator.translateForKey('paletteMenu.rgb', opts.language), () => emu.setPalette(1)),
        2: paletteMenu.addItem(translator.translateForKey('paletteMenu.yuv', opts.language), () => emu.setPalette(2)),
    }
    const setPaletteCheckbox = (palette) => {
        for (let i in paletteSelection) {
            if (parseInt(i) == palette) {
                paletteSelection[i].setBullet();
            } else {
                paletteSelection[i].unsetBullet();
            }
        }
    }
    emu.on('setPalette', setPaletteCheckbox);
    setPaletteCheckbox(emu.getPalette());

    if (!opts.sandbox) {
        ui.toolbar.addButton(openIcon, { label: translator.translateForKey('toolbar.openFile', opts.language) }, () => {
            openFileDialog();
        });
    }
    ui.toolbar.addButton(resetIcon, { label: translator.translateForKey('toolbar.reset', opts.language) }, () => {
        emu.reset();
    });
    const pauseButton = ui.toolbar.addButton(playIcon, { label: translator.translateForKey('toolbar.unpause', opts.language) }, () => {
        if (emu.isRunning) {
            emu.pause();
        } else {
            emu.start();
        }
    });
    emu.on('pause', () => {
        pauseButton.setIcon(playIcon);
        pauseButton.setLabel(translator.translateForKey('toolbar.unpause', opts.language));
    });
    emu.on('start', () => {
        pauseButton.setIcon(pauseIcon);
        pauseButton.setLabel(translator.translateForKey('toolbar.pause', opts.language));
    });
    const fullscreenButton = ui.toolbar.addButton(
        fullscreenIcon, { label: translator.translateForKey('toolbar.enterFullscreen', opts.language), align: 'right' },
        () => {
            ui.toggleFullscreen();
        }
    )

    ui.on('setZoom', (factor) => {
        if (factor == 'fullscreen') {
            fullscreenButton.setIcon(exitFullscreenIcon);
            fullscreenButton.setLabel(translator.translateForKey('toolbar.exitFullscreen', opts.language));
        } else {
            fullscreenButton.setIcon(fullscreenIcon);
            fullscreenButton.setLabel(translator.translateForKey('toolbar.enterFullscreen', opts.language));
        }
    });

    const openFileDialog = () => {
        fileDialog().then(files => {
            const file = files[0];
            emu.openFile(file).then(() => {
                if (emu.isInitiallyPaused) emu.start();
            }).catch((err) => { alert(err); });
        });
    }

    const openGameBrowser = () => {
        emu.pause();
        const body = ui.showDialog();
        body.innerHTML = `
            <label>` + translator.translateForKey('searchScreen.findGames', opts.language) + `</label>
            <form>
                <input type="search">
                <button type="submit">` + translator.translateForKey('searchScreen.search', opts.language) + `</button>
            </form>
            <div class="results">
            </div>
        `;
        const input = body.querySelector('input');
        const searchButton = body.querySelector('button');
        const searchForm = body.querySelector('form');
        const resultsContainer = body.querySelector('.results');

        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            searchButton.innerText = translator.translateForKey('searchScreen.searching', opts.language);
            const searchTerm = input.value.replace(/[^\w\s\-\']/, '');

            const encodeParam = (key, val) => {
                return encodeURIComponent(key) + '=' + encodeURIComponent(val);
            }

            const searchUrl = (
                'https://archive.org/advancedsearch.php?' +
                encodeParam('q', 'collection:softwarelibrary_zx_spectrum title:"' + searchTerm + '"') +
                '&' + encodeParam('fl[]', 'creator') +
                '&' + encodeParam('fl[]', 'identifier') +
                '&' + encodeParam('fl[]', 'title') +
                '&' + encodeParam('rows', '50') +
                '&' + encodeParam('page', '1') +
                '&' + encodeParam('output', 'json')
            )
            fetch(searchUrl).then(response => {
                searchButton.innerText = translator.translateForKey('searchScreen.search', opts.language);
                return response.json();
            }).then(data => {
                resultsContainer.innerHTML = '<ul></ul><p>- powered by <a href="https://archive.org/">Internet Archive</a></p>';
                const ul = resultsContainer.querySelector('ul');
                const results = data.response.docs;
                results.forEach(result => {
                    const li = document.createElement('li');
                    ul.appendChild(li);
                    const resultLink = document.createElement('a');
                    resultLink.href = '#';
                    resultLink.innerText = result.title;
                    const creator = document.createTextNode(' - ' + result.creator)
                    li.appendChild(resultLink);
                    li.appendChild(creator);
                    resultLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        fetch(
                            'https://archive.org/metadata/' + result.identifier
                        ).then(response => response.json()).then(data => {
                            let chosenFilename = null;
                            data.files.forEach(file => {
                                const ext = file.name.split('.').pop().toLowerCase();
                                if (ext == 'z80' || ext == 'sna' || ext == 'tap' || ext == 'tzx' || ext == 'szx') {
                                    chosenFilename = file.name;
                                }
                            });
                            if (!chosenFilename) {
                                alert(translator.translateForKey('searchScreen.notLoadableFileFound', opts.language));
                            } else {
                                const finalUrl = 'https://cors.archive.org/cors/' + result.identifier + '/' + chosenFilename;
                                emu.openUrl(finalUrl).catch((err) => {
                                    alert(err);
                                }).then(() => {
                                    ui.hideDialog();
                                    emu.start();
                                });
                            }
                        })
                    })
                })
            })
        })
        input.focus();
    }

    const exit = () => {
        emu.exit();
        ui.unload();
    }

    /*
        const benchmarkElement = document.getElementById('benchmark');
        setInterval(() => {
            benchmarkElement.innerText = (
                "Running at " + benchmarkRunCount + "fps, rendering at "
                + benchmarkRenderCount + "fps"
            );
            benchmarkRunCount = 0;
            benchmarkRenderCount = 0;
        }, 1000)
    */

    return {
        setZoom: (zoom) => { ui.setZoom(zoom); },
        toggleFullscreen: () => { ui.toggleFullscreen(); },
        enterFullscreen: () => { ui.enterFullscreen(); },
        exitFullscreen: () => { ui.exitFullscreen(); },
        setMachine: (model) => { emu.setMachine(model); },
        setPalette: (palette) => { emu.setPalette(palette); },
        openFileDialog: () => { openFileDialog(); },
        openUrl: (url) => {
            emu.openUrl(url).catch((err) => { alert(err); });
        },
        exit: () => { exit(); },
    };
};