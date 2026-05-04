import * as THREE from 'three';
import { InputManager } from './InputManager.js';
import { Player } from './Player.js';
import { Marco } from './Marco.js';
import { World } from './World.js';
import { GameManager } from './GameManager.js';
import { UIManager } from './UIManager.js';
import { SoundManager } from './SoundManager.js';
import { cancelAllPendingExtraDisposals, resetExplosionGlobals } from './Explosion.js';

// ============================================
// レンダラー
// ============================================
const canvas = document.getElementById('game-canvas');
// logarithmicDepthBuffer: near 0.1 / far 1000（比 1:10000）の深度精度低下による
// Z-fighting を抑制。背景プロップが密集する Wave3+ の点滅対策。
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
// 適応解像度: 初期は最大1.5、低FPSなら自動的に下げる
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio, 1.5);
const MIN_PIXEL_RATIO = 0.75;
let currentPixelRatio = MAX_PIXEL_RATIO;
renderer.setPixelRatio(currentPixelRatio);
renderer.shadowMap.enabled = true;
// PCFSoft → PCF（ソフトシャドウ計算分のフィルタ重さを削減。屋外光なので差は微小）
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.4;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ============================================
// シーン
// ============================================
const scene = new THREE.Scene();

// ============================================
// カメラ（斜め見下ろし 3/4 view - Panzer Dragoon風）
// プレイヤーの後方上空から +Z 方向（前方）を見る
// ============================================
// far: 500 → 1000。World チャンクの生成距離（scrollZ + 90）を超えても余裕を持たせ、
// 遠方オブジェクトが far plane を出入りすることによる点滅/消失を防ぐ。
// フォグ（line 117 の FogExp2）が遠景を自然にフェードアウトさせるため、far 拡張による描画コストは限定的。
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 1000);
const CAMERA_OFFSET = new THREE.Vector3(0, 14, -18);
const CAMERA_LOOK_AHEAD = 10;
camera.position.set(0, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
camera.lookAt(0, 4, CAMERA_LOOK_AHEAD);

// ============================================
// 自動スクロール設定（+Z 方向へ前進）
// ============================================
const SCROLL_SPEED = 5.0;
let scrollZ = 0;
let scrollPaused = false;

// Wikimedia Commons: Desert panorama, UAE, February 2016 (CC BY-SA 4.0)
const WEB_BG_URL = 'https://upload.wikimedia.org/wikipedia/commons/3/31/Desert_panorama%2C_UAE%2C_February_2016.jpg';

// 画面シェイク用
let shakeIntensity = 0;
const shakeDecay = 0.88;

// カメラズーム演出
let cameraZoomTarget = 1.0;
let cameraZoomCurrent = 1.0;

// ヒットストップ（一瞬時間を止めて打撃感を強化）
let hitstopTimer = 0;
function triggerHitstop(duration) {
    if (duration > hitstopTimer) hitstopTimer = duration;
}

// カメラキック（キル時の寄り演出）
let cameraKickTimer = 0;
let cameraKickAmount = 0;
function triggerCameraKick(amount, duration) {
    if (amount > cameraKickAmount) cameraKickAmount = amount;
    if (duration > cameraKickTimer) cameraKickTimer = duration;
}

// ============================================
// ライティング（Metal Slug風 — 強い砂漠の太陽光）
// ============================================
const ambientLight = new THREE.AmbientLight(0xFFDDA0, 0.65);
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xFFF0B8, 2.5);
dirLight.position.set(22, 38, 14);
dirLight.castShadow = true;
// 2048→512、影カメラ範囲も実プレイ範囲に絞り、毎フレームのシャドウパス負荷を大幅削減
dirLight.shadow.mapSize.width = 512;
dirLight.shadow.mapSize.height = 512;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 90;
dirLight.shadow.camera.left = -28;
dirLight.shadow.camera.right = 28;
dirLight.shadow.camera.top = 32;
dirLight.shadow.camera.bottom = -22;
dirLight.shadow.bias = -0.001;
// 0.08 は peter-panning（影が浮く）で別種のチラつきが出るため 0.04 に戻す
dirLight.shadow.normalBias = 0.04;
scene.add(dirLight);

const lightTarget = new THREE.Object3D();
scene.add(lightTarget);
dirLight.target = lightTarget;

// 半球ライト: Metal Slug風の鮮やかな空×暖かい砂漠の反射光
const hemiLight = new THREE.HemisphereLight(0x88C0F0, 0xE8B060, 0.65);
scene.add(hemiLight);

// リムライト: 強い逆光（キャラクターの輪郭を強調）
const rimLight = new THREE.DirectionalLight(0xFFB050, 0.55);
rimLight.position.set(-15, 12, -18);
scene.add(rimLight);

// フィルライト: 影を少し和らげる空色の反射
const fillLight = new THREE.DirectionalLight(0x80B0E0, 0.22);
fillLight.position.set(-10, 5, 10);
scene.add(fillLight);

// フォグ（遠景の砂漠ヘイズ — より暖かい色）
scene.fog = new THREE.FogExp2(0xDCC088, 0.005);

// ============================================
// ゲームオブジェクト
// ============================================
const input = new InputManager(canvas);
const world = new World(scene, { backgroundPhotoUrl: WEB_BG_URL });
const player = new Player(scene, camera);
const gameManager = new GameManager(scene);
const uiManager = new UIManager(camera);
const soundManager = new SoundManager();

player.soundManager = soundManager;
player.world = world;

// チャージ砲のティアに応じた打撃感
player.onChargeFire = (tier) => {
    if (tier >= 2) {
        shakeIntensity = Math.max(shakeIntensity, 0.55);
        triggerHitstop(0.045);
        cameraZoomTarget = 0.95;
        uiManager.triggerImpactFlash(0.9, false);
    } else if (tier >= 1) {
        shakeIntensity = Math.max(shakeIntensity, 0.3);
        triggerHitstop(0.025);
    } else {
        shakeIntensity = Math.max(shakeIntensity, 0.18);
    }
};
gameManager.soundManager = soundManager;
gameManager.world = world;

// Feature 3: 徒歩キャラクター (Marco)
const marco = new Marco(scene, camera);
let gameMode = 'tank'; // 'tank' | 'foot'

// スクロール情報をゲームマネージャーに渡す
gameManager.getScrollZ = () => scrollZ;
gameManager.getScrollSpeed = () => SCROLL_SPEED;

// ロックオン用: 敵リスト & ボスへのアクセスを渡す
player.getEnemies = () => gameManager.enemies;
player.getBoss = () => gameManager.boss;
marco.getEnemies = () => gameManager.enemies;
marco.getBoss = () => gameManager.boss;
marco.world = world;

// ============================================
// 環境パーティクル（浮遊する砂塵）
// ============================================
const dustMotes = [];
const dustMat = new THREE.MeshBasicMaterial({
    color: 0xE8C890, transparent: true, opacity: 0.3,
});
// 40 個 → 24 個、ジオメトリ共有。粒子数が多いほど見た目に効くが、視覚差は微小。
const dustGeo = new THREE.SphereGeometry(0.08, 4, 3);
for (let i = 0; i < 24; i++) {
    const mote = new THREE.Mesh(dustGeo, dustMat);
    mote.scale.setScalar(0.6 + Math.random() * 1.4);
    mote.position.set(
        (Math.random() - 0.5) * 30,
        1 + Math.random() * 8,
        (Math.random() - 0.5) * 60
    );
    scene.add(mote);
    dustMotes.push({
        mesh: mote, baseY: mote.position.y,
        phase: Math.random() * Math.PI * 2,
        driftX: (Math.random() - 0.5) * 0.3,
        driftZ: (Math.random() - 0.5) * 0.5,
    });
}

// ============================================
// コールバック接続
// ============================================
gameManager.onEnemyKilled = (enemy) => {
    const finalScore = uiManager.onEnemyKilled(enemy.type, enemy.subType, enemy.scoreValue, enemy.getPosition());
    if (enemy.type === 'infantry') {
        soundManager.playExplosionSmall();
        // 軽い打撃感
        triggerHitstop(0.022);
        triggerCameraKick(0.015, 0.12);
    } else {
        soundManager.playExplosionLarge();
        // 重い打撃感（戦車・航空機）
        triggerHitstop(0.055);
        triggerCameraKick(0.035, 0.2);
        uiManager.triggerImpactFlash(1.0, false);
    }
    if (uiManager.comboCount >= 2) {
        soundManager.playCombo(uiManager.comboCount);
    }
    return finalScore;
};

gameManager.onWaveChange = (waveNum) => {
    uiManager.announceWave(waveNum);
    soundManager.playWaveStart();
};

gameManager.onPlayerHit = (hp, maxHp) => {
    shakeIntensity = Math.max(shakeIntensity, 0.4);
    uiManager.triggerDamageFlash();
    soundManager.playPlayerHit();
};

gameManager.onScreenShake = (intensity) => {
    shakeIntensity = Math.max(shakeIntensity, intensity);
    if (intensity > 0.3) cameraZoomTarget = 0.97;
    // 大きな爆発はヒットストップとインパクトフラッシュを発生
    if (intensity > 0.6) {
        triggerHitstop(Math.min(0.08, 0.04 + intensity * 0.03));
        uiManager.triggerImpactFlash(Math.min(1.4, intensity), false);
    } else if (intensity > 0.35) {
        triggerHitstop(0.03);
    }
};

gameManager.onGameOver = (score, kills, wave) => {
    shakeIntensity = 1.2;
    uiManager.showGameOver(score, kills, wave, uiManager.maxCombo);
    cameraZoomTarget = 0.92;
    soundManager.playGameOver();
};

gameManager.onBossHpChange = (hp, maxHp) => {
    uiManager.showBossHp(hp, maxHp);
};

gameManager.onBossDefeated = () => {
    uiManager.hideBossHp();
    soundManager.playWaveStart();
    scrollPaused = false;
    // ボス出現時に変更したライトをデイライト初期値へ戻す
    ambientLight.color.setHex(0xFFDDA0);
    ambientLight.intensity = 0.65;
    dirLight.color.setHex(0xFFF0B8);
    dirLight.intensity = 2.5;
};

gameManager.onBossSpawn = () => {
    scrollPaused = true;
    shakeIntensity = 0.8;
    cameraZoomTarget = 0.93;
    ambientLight.color.setHex(0xFFBB88);
    ambientLight.intensity = 0.4;
    dirLight.color.setHex(0xFFAA77);
    dirLight.intensity = 1.5;
};

// Feature 1: POW 救出コールバック
gameManager.onPowRescued = (reward) => {
    uiManager.showRescueBanner(reward);
    cameraZoomTarget = 0.96;
};

// Feature 3: 降車 / 搭乗 (Q キー)
window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyQ' || !gameStarted || gameManager.gameOver) return;
    if (gameMode === 'tank') {
        gameMode = 'foot';
        marco.dismount(player.getPosition());
        player.group.visible = false;
    } else {
        const d = marco.group.position.distanceTo(player.getPosition());
        if (d < 5) {
            gameMode = 'tank';
            marco.mount();
            player.group.visible = true;
            player.invincibleTimer = 0.5;
        }
    }
});

// ============================================
// タイトル画面 & ゲーム開始管理
// ============================================
let gameStarted = false;
const titleScreen = document.getElementById('title-screen');
const uiOverlay = document.getElementById('ui-overlay');
const controlsHint = document.getElementById('controls-hint');

// HUDを最初は非表示
if (uiOverlay) uiOverlay.style.opacity = '0';

function startGame() {
    if (gameStarted) return;
    gameStarted = true;

    // タイトルBGMを停止
    soundManager.stopBGM();

    // タイトル画面をフェードアウト
    if (titleScreen) {
        titleScreen.classList.add('title-hidden');
        setTimeout(() => { titleScreen.style.display = 'none'; }, 600);
    }

    // HUDをフェードイン
    if (uiOverlay) {
        uiOverlay.style.transition = 'opacity 0.5s ease';
        uiOverlay.style.opacity = '1';
    }

    // MISSION START 演出
    setTimeout(() => {
        uiManager.showMissionStart();
        soundManager.playMissionStart();
        soundManager.startBGM();
        setTimeout(() => uiManager.announceWave(1), 2000);
    }, 300);

    // コントロールヒントを8秒後にフェードアウト
    setTimeout(() => {
        if (controlsHint) controlsHint.classList.add('controls-faded');
    }, 8000);
}

// タイトル画面での開始キー
window.addEventListener('keydown', (e) => {
    if (!gameStarted && (e.code === 'Space' || e.code === 'Enter')) {
        e.preventDefault();
        startGame();
    }
    // タイトル画面でBGMを開始（初回インタラクション）
    if (!gameStarted && !soundManager.bgmPlaying) {
        soundManager.startTitleBGM();
    }
});
// マウスクリックでも開始可能
if (titleScreen) {
    titleScreen.addEventListener('click', () => {
        // タイトル画面でBGMを開始（初回インタラクション）
        if (!gameStarted && !soundManager.bgmPlaying) {
            soundManager.startTitleBGM();
        }
        startGame();
    });
}

// ============================================
// エイムカーソル
// ============================================
const cursorGeo = new THREE.RingGeometry(0.3, 0.45, 20);
const cursorMat = new THREE.MeshBasicMaterial({
    color: 0xFF3333, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
});
const aimCursor = new THREE.Mesh(cursorGeo, cursorMat);
aimCursor.rotation.x = -Math.PI / 2;
aimCursor.position.y = 0.05;
scene.add(aimCursor);

const crossGeo1 = new THREE.BoxGeometry(0.7, 0.01, 0.05);
const crossGeo2 = new THREE.BoxGeometry(0.05, 0.01, 0.7);
const crossMat = new THREE.MeshBasicMaterial({
    color: 0xFF3333, transparent: true, opacity: 0.4,
});
const cross1 = new THREE.Mesh(crossGeo1, crossMat);
const cross2 = new THREE.Mesh(crossGeo2, crossMat);
cross1.position.y = 0.06;
cross2.position.y = 0.06;
scene.add(cross1);
scene.add(cross2);

const dotGeo = new THREE.CircleGeometry(0.06, 8);
const dotMat = new THREE.MeshBasicMaterial({
    color: 0xFF2222, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
});
const aimDot = new THREE.Mesh(dotGeo, dotMat);
aimDot.rotation.x = -Math.PI / 2;
aimDot.position.y = 0.07;
scene.add(aimDot);

// ============================================
// リスタート & ミュート
// ============================================
function isRestartKey(event) {
    return event.code === 'KeyR' || event.key === 'r' || event.key === 'R';
}

// シーン直下の "保持しても良い" 永続オブジェクトを集合として持つ。
// リスタート時の防衛的クリーンアップで、これらに含まれない直下メッシュは
// dispose して取り除く。World/Player/Marco の管理対象は内部 reset で扱われるため、
// ここでは scene.children を一階層だけ走査する（深い traverse は不要）。
function _collectPermanentRoots() {
    const roots = new Set([
        ambientLight, dirLight, lightTarget, hemiLight, rimLight, fillLight,
        aimCursor, cross1, cross2, aimDot,
        player.group, marco.group,
    ]);
    if (world.bgLayers) world.bgLayers.forEach(l => l.objects && l.objects.forEach(o => roots.add(o)));
    if (world.clouds) world.clouds.forEach(c => roots.add(c.group));
    if (world.photoForegroundMeshes) world.photoForegroundMeshes.forEach(e => roots.add(e.mesh));
    if (world.chunks) world.chunks.forEach(c => c.objects.forEach(o => roots.add(o)));
    if (world.skyMesh) roots.add(world.skyMesh);
    if (world.groundMesh) roots.add(world.groundMesh);
    return roots;
}

function _deepCleanScene() {
    const keep = _collectPermanentRoots();
    // 爆発ライトプールの light は scene.children に含まれるが _lightPool に属するので
    // まず一旦すべて keep 集合に積む（resetExplosionGlobals 後なので非アクティブ）
    scene.children.slice().forEach(obj => {
        if (obj.isLight) keep.add(obj); // 全ライトは温存（プール光含む）
    });
    const toRemove = scene.children.filter(o => !keep.has(o));
    toRemove.forEach(obj => {
        scene.remove(obj);
        if (obj.traverse) {
            obj.traverse(child => {
                if (child.isMesh) {
                    if (child.geometry && child.geometry.dispose) {
                        try { child.geometry.dispose(); } catch (e) { /* shared */ }
                    }
                    if (child.material) {
                        const mats = Array.isArray(child.material) ? child.material : [child.material];
                        mats.forEach(m => { try { m.dispose && m.dispose(); } catch (e) { /* shared */ } });
                    }
                }
            });
        }
    });
}

window.addEventListener('keydown', (e) => {
    if (isRestartKey(e) && gameManager.gameOver) {
        e.preventDefault();
        restartGame();
    }
    if (e.code === 'KeyM') soundManager.toggleMute();
    // ゲームオーバー時にSPACEでもリスタート
    if (e.code === 'Space' && gameManager.gameOver) {
        e.preventDefault();
        restartGame();
    }
});

function restartGame() {
    // 前ゲームの未発火 setTimeout（焦げ跡/岩塊の遅延 dispose）を取り消し、
    // 新ゲーム中に過去 mesh が突然消える/メモリが揺れる症状を防ぐ。
    cancelAllPendingExtraDisposals();
    // 爆発ライトプール（_activeExplosionLights カウンタ + 各 light の _busy フラグ）を初期化。
    // これを呼ばないと、Game Over 時点で update が止まったまま release されなかった
    // ライトが永続的に占有されたままになり、新ゲームの爆発が無灯化＋古いライトが
    // シーン上で点きっぱなしになって点滅・重さの原因になる。
    resetExplosionGlobals();
    uiManager.reset();
    player.restart();
    gameManager.restart();
    gameMode = 'tank';
    marco.mount();
    player.group.visible = true;
    elapsedTime = 0;
    scrollZ = 0;
    scrollPaused = false;
    shakeIntensity = 0;
    cameraZoomTarget = 1.0;
    cameraZoomCurrent = 1.0;
    // メモリプレッシャー監視・ヒットストップ・カメラキックなどのループ局所状態もリセット。
    // 残ったまま新ゲームに入ると、開始直後の数フレームで強制 shift が走り、
    // 表示エフェクトが一瞬で消える点滅が発生する。
    memPressureTimer = 0;
    memPressureLevel = 0;
    memPressureCooldown = 0;
    renderListsCleanupTimer = 0;
    hitstopTimer = 0;
    cameraKickTimer = 0;
    cameraKickAmount = 0;
    // 適応解像度の FPS 計測もリセット。前ゲームの低 FPS 計測値が残ると
    // 新ゲームの開始直後に誤判定で解像度を更に下げる挙動になりうる。
    fpsAccumulator = 0;
    fpsFrameCount = 0;
    fpsCheckTimer = 0;
    // ボス戦中に Game Over した場合、ライトがボス戦カラーのまま残るので明示的に戻す。
    ambientLight.color.setHex(0xFFDDA0);
    ambientLight.intensity = 0.65;
    dirLight.color.setHex(0xFFF0B8);
    dirLight.intensity = 2.5;
    world.reset(scrollZ);
    // シーン防衛的クリーンアップ: 既知の永続オブジェクト以外の遺残メッシュを除去。
    // dispose 漏れの最後のセーフティネット。
    _deepCleanScene();
    // 前ゲームの RenderList キャッシュも解放しておく（テクスチャ・プログラム参照のリーク予防）。
    if (renderer.renderLists && renderer.renderLists.dispose) {
        renderer.renderLists.dispose();
    }
    // シェーダプリコンパイル: 新生成チャンクのマテリアルが初フレームで
    // インラインコンパイルされるとフレームが詰まる（リスタート直後の重さの一因）。
    try { renderer.compile(scene, camera); } catch (e) { /* noop */ }
    setTimeout(() => {
        uiManager.showMissionStart();
        soundManager.playMissionStart();
        soundManager.startBGM();
        setTimeout(() => uiManager.announceWave(1), 2000);
    }, 300);
    // コントロールヒントを再表示して再度フェードアウト
    if (controlsHint) {
        controlsHint.classList.remove('controls-faded');
        setTimeout(() => {
            if (controlsHint) controlsHint.classList.add('controls-faded');
        }, 8000);
    }
}

// ============================================
// リサイズ
// ============================================
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================
// ゲームループ
// ============================================
let lastTime = -1;
let isFirstFrame = true;
let elapsedTime = 0;
let memPressureTimer = 0;
// 数秒に 1 度の renderer.renderLists.dispose() 用タイマー。
// renderLists は draw call ごとの一時リストをキャッシュするが、
// 長時間プレイで shader program / RenderList オブジェクトが滞留して
// JS ヒープが膨張するのを防ぐため定期的に解放する。
let renderListsCleanupTimer = 0;
// 直近のメモリ圧レベル（0=平常, 1=高, 2=危機）。
// 1 度危機に入ったら一定時間は緩めの閾値で監視を続け、
// 復帰直後に再度膨張する振動を防ぐ。
let memPressureLevel = 0;
let memPressureCooldown = 0;

// エフェクトを安全に解放する（destroy() があればそれを優先、無ければ traverse で dispose）
function forceReleaseEffect(effect) {
    if (!effect) return;
    if (typeof effect.destroy === 'function') {
        try {
            effect.destroy();
            return;
        } catch (_) { /* 多重呼出しの保険 */ }
    }
    effect.alive = false;
    if (effect.group) {
        if (effect.group.parent) effect.group.parent.remove(effect.group);
        effect.group.traverse(child => {
            if (child.isMesh) {
                if (child.geometry && child.geometry.dispose) child.geometry.dispose();
                if (child.material && child.material.dispose) child.material.dispose();
            }
        });
    }
}

// 適応解像度: 直近フレームの平均 FPS を見て pixel ratio を調整
// 低 FPS → 解像度を下げて即時に滑らかさ復帰
// 高 FPS → ゆっくり解像度を戻し画質を維持
let fpsAccumulator = 0;
let fpsFrameCount = 0;
let fpsCheckTimer = 0;
const FPS_TARGET_LOW  = 48;  // これより低いと解像度ダウン
const FPS_TARGET_HIGH = 58;  // これより高い時のみ解像度アップ
function _updateAdaptiveResolution(rawDt) {
    fpsAccumulator += rawDt;
    fpsFrameCount++;
    fpsCheckTimer += rawDt;
    if (fpsCheckTimer < 0.6) return;  // 0.6秒ごとに評価
    const avgFps = fpsFrameCount / fpsAccumulator;
    fpsAccumulator = 0;
    fpsFrameCount = 0;
    fpsCheckTimer = 0;
    if (avgFps < FPS_TARGET_LOW && currentPixelRatio > MIN_PIXEL_RATIO) {
        currentPixelRatio = Math.max(MIN_PIXEL_RATIO, currentPixelRatio - 0.15);
        renderer.setPixelRatio(currentPixelRatio);
    } else if (avgFps > FPS_TARGET_HIGH && currentPixelRatio < MAX_PIXEL_RATIO) {
        currentPixelRatio = Math.min(MAX_PIXEL_RATIO, currentPixelRatio + 0.05);
        renderer.setPixelRatio(currentPixelRatio);
    }
}

function gameLoop(timestamp) {
    requestAnimationFrame(gameLoop);

    if (isFirstFrame) {
        lastTime = timestamp;
        isFirstFrame = false;
        renderer.render(scene, camera);
        return;
    }

    const rawDt = Math.min((timestamp - lastTime) / 1000, 0.033);
    lastTime = timestamp;

    // 適応解像度の更新（タイトル中も計測してウォームアップ）
    if (rawDt > 0) _updateAdaptiveResolution(rawDt);

    // ヒットストップ適用（ゲームプレイ時間だけ一瞬止める。UIは通常速度）
    let dt = rawDt;
    if (hitstopTimer > 0) {
        hitstopTimer -= rawDt;
        dt = rawDt * 0.08; // 92% freeze
        if (hitstopTimer < 0) hitstopTimer = 0;
    }

    elapsedTime += dt;

    // タイトル画面中はゲームを停止
    if (!gameStarted) {
        renderer.render(scene, camera);
        return;
    }

    // 自動スクロール更新
    if (!gameManager.gameOver && !scrollPaused) {
        scrollZ += SCROLL_SPEED * dt;
    }

    // プレイヤー更新 (Feature 3: モード分岐)
    player.scrollZ = scrollZ;
    const activeEntity = gameMode === 'tank' ? player : marco;
    // ゲームオーバー中は player/marco の update を完全にスキップ。
    // 入力で新たな弾/エフェクトが生成され続けるのを止め、restart 時の蓄積を防ぐ。
    if (!gameManager.gameOver) {
        if (gameMode === 'tank') {
            player.update(dt, input, elapsedTime);
            // 非アクティブ側（徒歩モード）の残存弾・エフェクトを解放
            for (let i = marco.projectiles.length - 1; i >= 0; i--) {
                const p = marco.projectiles[i];
                if (p.destroy) p.destroy();
                marco.projectiles.splice(i, 1);
            }
            for (let i = marco.effects.length - 1; i >= 0; i--) {
                const e = marco.effects[i];
                if (e.destroy) e.destroy();
                marco.effects.splice(i, 1);
            }
        } else {
            marco.scrollZ = scrollZ;
            marco.update(dt, input, scrollZ);
            // 戦車が画面外に流れないよう位置をスクロールに追従させる
            player.group.position.z = scrollZ + player.localOffsetZ;
            // マルコが死んだら戦車モードに戻る
            if (marco.dead) {
                gameMode = 'tank';
                player.group.visible = true;
                player.takeDamage(player.hp);
            }
        }
    }
    const playerPos = activeEntity.getPosition();

    // ゲームマネージャー更新
    gameManager.update(dt, activeEntity, elapsedTime);

    // ワールド更新
    world.update(dt, scrollZ);

    // UI更新
    uiManager.update(dt, gameManager, activeEntity);

    // スクロール進行バー更新（ウェーブ進行度ベース）
    const waveProgress = gameManager.waveElapsed / (gameManager.waves[Math.min(gameManager.waveIndex, gameManager.waves.length - 1)].duration || 30);
    const totalProgress = (gameManager.waveIndex + Math.min(waveProgress, 1)) / gameManager.waves.length;
    uiManager.updateScrollProgress(totalProgress);

    // アイテム更新 & ピックアップ
    for (let i = gameManager.items.length - 1; i >= 0; i--) {
        const item = gameManager.items[i];
        item.update(dt);
        if (item.checkPickup(playerPos)) {
            const bonus = item.applyEffect(player);
            if (bonus > 0) {
                gameManager.score += bonus;
                if (gameManager.onScoreChange) gameManager.onScoreChange(gameManager.score);
            }
            uiManager.showItemPickup(item.type, bonus);
            soundManager.playCombo(3);
            item.destroy();
        }
        if (!item.alive) {
            if (!item.collected) item.destroy();
            gameManager.items.splice(i, 1);
        }
    }

    // プレイヤー弾のメモリ管理: 画面外の弾丸を削除
    const activeProjectiles = activeEntity.projectiles || [];
    for (let i = activeProjectiles.length - 1; i >= 0; i--) {
        const p = activeProjectiles[i];
        if (!p.alive && !p.impactPending) {
            p.destroy();
            activeProjectiles.splice(i, 1);
        } else if (p.alive) {
            const pPos = p.getPosition ? p.getPosition() : (p.group ? p.group.position : null);
            if (pPos && (pPos.z < scrollZ - 60 || pPos.z > scrollZ + 120)) {
                p.destroy();
                activeProjectiles.splice(i, 1);
            }
        }
    }
    // アクティブキャラのエフェクト上限管理
    // shift しただけだと scene 上の Mesh は残るので、必ず後処理で解放する。
    // Wave 12以降は同時敵・発射物が増えるため、エフェクト保持数も少し絞る。
    const activeEffects = activeEntity.effects || [];
    const activeEffectLimit = gameManager.getCurrentWave() >= 12 ? 32 : 40;
    while (activeEffects.length > activeEffectLimit) {
        const old = activeEffects.shift();
        forceReleaseEffect(old);
    }

    // ランタイム全体のメモリプレッシャー監視
    // - Three.js リソース数 (geometries / textures) と draw call
    // - JS ヒープ (Chrome の performance.memory が利用可能なら)
    // 3 段階で段階的にクリーンアップし、5GB に達するような暴走を防ぐ。
    memPressureTimer += rawDt;
    if (memPressureCooldown > 0) memPressureCooldown -= rawDt;
    if (memPressureTimer >= 0.5) {
        memPressureTimer = 0;
        const geoCount = renderer.info.memory.geometries;
        const texCount = renderer.info.memory.textures;
        const renderCalls = renderer.info.render.calls;
        // Chrome は performance.memory.usedJSHeapSize を MB 単位で取得できる。
        // 他ブラウザでは undefined のため、その場合はリソース数のみで判定する。
        const heapMB = (performance && performance.memory && performance.memory.usedJSHeapSize)
            ? performance.memory.usedJSHeapSize / (1024 * 1024) : 0;

        // クールダウン中は閾値を緩めて頻繁な切替を防ぐ
        const onCooldown = memPressureCooldown > 0;
        const HIGH_GEO     = onCooldown ? 1500 : 1800;
        const HIGH_TEX     = onCooldown ? 250  : 320;
        const HIGH_CALLS   = onCooldown ? 700  : 850;
        const HIGH_HEAP_MB = onCooldown ? 900  : 1200;
        const CRIT_GEO     = onCooldown ? 1900 : 2200;
        const CRIT_TEX     = onCooldown ? 380  : 460;
        const CRIT_CALLS   = onCooldown ? 950  : 1100;
        const CRIT_HEAP_MB = onCooldown ? 1500 : 1900;

        const isHigh =
            geoCount > HIGH_GEO || texCount > HIGH_TEX ||
            renderCalls > HIGH_CALLS || (heapMB > 0 && heapMB > HIGH_HEAP_MB);
        const isCritical =
            geoCount > CRIT_GEO || texCount > CRIT_TEX ||
            renderCalls > CRIT_CALLS || (heapMB > 0 && heapMB > CRIT_HEAP_MB);

        if (isCritical) {
            memPressureLevel = 2;
            memPressureCooldown = 6.0;
            // 解像度を下限に固定
            if (currentPixelRatio > MIN_PIXEL_RATIO) {
                currentPixelRatio = MIN_PIXEL_RATIO;
                renderer.setPixelRatio(currentPixelRatio);
            }
            // GameManager とアクティブキャラのエフェクトをほぼ全廃
            while (gameManager.effects.length > 12) {
                const old = gameManager.effects.shift();
                gameManager._forceDestroyEffect(old);
            }
            while (activeEffects.length > 12) {
                const old = activeEffects.shift();
                forceReleaseEffect(old);
            }
            // 残弾も古いものから削る（敵 / ボス / プレイヤー）
            gameManager.enemies.forEach(enemy => {
                while (enemy.projectiles && enemy.projectiles.length > 6) {
                    const old = enemy.projectiles.shift();
                    if (old && old.destroy) old.destroy();
                }
            });
            if (gameManager.boss && gameManager.boss.projectiles) {
                while (gameManager.boss.projectiles.length > 12) {
                    const old = gameManager.boss.projectiles.shift();
                    if (old && old.destroy) old.destroy();
                }
            }
            while (activeProjectiles.length > 20) {
                const old = activeProjectiles.shift();
                if (old && old.destroy) old.destroy();
            }
            // 後方の敵 / アイテム / POW を即座にクリーンアップ
            gameManager.cleanupTimer = 999;
            // World のチャンク dispose をこのフレーム多めに許可
            if (world && world.maxChunkDisposesPerFrame !== undefined) {
                world._memPressureBoost = 6;
            }
            // renderer の RenderList キャッシュ + WebGL info を解放
            if (renderer.renderLists && renderer.renderLists.dispose) {
                renderer.renderLists.dispose();
            }
        } else if (isHigh) {
            memPressureLevel = 1;
            memPressureCooldown = 3.0;
            if (currentPixelRatio > MIN_PIXEL_RATIO) {
                currentPixelRatio = Math.max(MIN_PIXEL_RATIO, currentPixelRatio - 0.15);
                renderer.setPixelRatio(currentPixelRatio);
            }
            while (gameManager.effects.length > 24) {
                const old = gameManager.effects.shift();
                gameManager._forceDestroyEffect(old);
            }
            while (activeEffects.length > 24) {
                const old = activeEffects.shift();
                forceReleaseEffect(old);
            }
            // GameManager の cleanup を 1 段早める
            gameManager.cleanupTimer = Math.max(gameManager.cleanupTimer, 0.45);
        } else if (memPressureLevel > 0 && memPressureCooldown <= 0) {
            memPressureLevel = 0;
        }
    }

    // RenderList キャッシュの定期解放（10 秒ごと）。
    // dispose しても scene 上のオブジェクトには影響しないが、
    // three.js が draw call ごとに保持する内部キャッシュ
    // (WebGLRenderList / WebGLProgram の参照) を解放してヒープ膨張を抑える。
    renderListsCleanupTimer += rawDt;
    if (renderListsCleanupTimer >= 10.0) {
        renderListsCleanupTimer = 0;
        if (renderer.renderLists && renderer.renderLists.dispose) {
            renderer.renderLists.dispose();
        }
    }

    // エイムカーソル（地面 Y=0 平面上）
    const aimPos = activeEntity.getAimPoint();
    aimCursor.position.set(aimPos.x, 0.05, aimPos.z);
    cross1.position.set(aimPos.x, 0.06, aimPos.z);
    cross2.position.set(aimPos.x, 0.06, aimPos.z);
    aimDot.position.set(aimPos.x, 0.07, aimPos.z);
    aimCursor.rotation.z += dt * 1.5;
    aimCursor.scale.setScalar(1 + Math.sin(elapsedTime * 4) * 0.08);

    // 環境パーティクル更新
    dustMotes.forEach(d => {
        d.phase += dt * 0.8;
        d.mesh.position.y = d.baseY + Math.sin(d.phase) * 0.5;
        d.mesh.position.x += d.driftX * dt;
        d.mesh.position.z += d.driftZ * dt;
        if (Math.abs(d.mesh.position.z - scrollZ) > 30) {
            d.mesh.position.x = (Math.random() - 0.5) * 30;
            d.mesh.position.z = scrollZ + (Math.random() - 0.5) * 50;
            d.baseY = 1 + Math.random() * 8;
        }
    });

    // カメラズーム復帰
    cameraZoomTarget += (1.0 - cameraZoomTarget) * rawDt * 2;
    cameraZoomCurrent += (cameraZoomTarget - cameraZoomCurrent) * rawDt * 5;

    // カメラキック（キル時の短い寄り）
    let kickZoom = 1.0;
    if (cameraKickTimer > 0) {
        cameraKickTimer -= rawDt;
        const t = Math.max(0, cameraKickTimer) / 0.2;
        kickZoom = 1.0 - cameraKickAmount * t;
        if (cameraKickTimer <= 0) {
            cameraKickTimer = 0;
            cameraKickAmount *= 0.5;
        }
    } else {
        cameraKickAmount *= 0.85;
    }
    // カメラは横方向（X）はactiveEntityに柔らかく追従
    const laneX = (activeEntity.displayOffsetX ?? activeEntity.getPosition().x) * 0.35;

    // カメラ追従（3/4 view、+Z 方向を見る）
    const effectiveZoom = cameraZoomCurrent * kickZoom;
    const targetCamPos = new THREE.Vector3(
        laneX,
        CAMERA_OFFSET.y * effectiveZoom,
        scrollZ + CAMERA_OFFSET.z * effectiveZoom
    );
    camera.position.lerp(targetCamPos, 0.08);

    const lookTarget = new THREE.Vector3(
        laneX * 0.75,
        4,
        scrollZ + CAMERA_LOOK_AHEAD
    );

    // 画面シェイク
    if (shakeIntensity > 0.01) {
        camera.position.x += (Math.random() - 0.5) * shakeIntensity * 2;
        camera.position.y += (Math.random() - 0.5) * shakeIntensity * 2;
        shakeIntensity *= shakeDecay;
    } else {
        shakeIntensity = 0;
    }

    camera.lookAt(lookTarget);

    // ライト追従
    dirLight.position.set(20, 30, scrollZ + 12);
    lightTarget.position.set(0, 0, scrollZ);
    rimLight.position.set(-15, 12, scrollZ - 18);

    renderer.render(scene, camera);
    input.endFrame();
}

requestAnimationFrame(gameLoop);
