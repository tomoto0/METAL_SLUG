import * as THREE from 'three';
import { InputManager } from './InputManager.js';
import { Player } from './Player.js';
import { Marco } from './Marco.js';
import { World } from './World.js';
import { GameManager } from './GameManager.js';
import { UIManager } from './UIManager.js';
import { SoundManager } from './SoundManager.js';

// ============================================
// レンダラー
// ============================================
const canvas = document.getElementById('game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 500);
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
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 120;
dirLight.shadow.camera.left = -50;
dirLight.shadow.camera.right = 50;
dirLight.shadow.camera.top = 50;
dirLight.shadow.camera.bottom = -50;
dirLight.shadow.bias = -0.001;
dirLight.shadow.normalBias = 0.02;
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
gameManager.soundManager = soundManager;
gameManager.world = world;

// Feature 3: 徒歩キャラクター (Marco)
const marco = new Marco(scene, camera);
let gameMode = 'tank'; // 'tank' | 'foot'

// スクロール情報をゲームマネージャーに渡す
gameManager.getScrollZ = () => scrollZ;
gameManager.getScrollSpeed = () => SCROLL_SPEED;

// 対空ロックオン用: Player に敵リストへのアクセスを渡す
player.getEnemies = () => gameManager.enemies;

// ============================================
// 環境パーティクル（浮遊する砂塵）
// ============================================
const dustMotes = [];
const dustMat = new THREE.MeshBasicMaterial({
    color: 0xE8C890, transparent: true, opacity: 0.3,
});
for (let i = 0; i < 40; i++) {
    const size = 0.05 + Math.random() * 0.1;
    const geo = new THREE.SphereGeometry(size, 4, 3);
    const mote = new THREE.Mesh(geo, dustMat);
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

    const timeOfDay = [
        { ambient: 0xFFDDA0, ambientI: 0.65, dir: 0xFFF0B8, dirI: 2.5, hemiSky: 0x88C0F0, hemiGnd: 0xE8B060, hemiI: 0.65, fog: 0xDCC088 },
        { ambient: 0xFFDDA0, ambientI: 0.62, dir: 0xFFF0B8, dirI: 2.3, hemiSky: 0x88C0F0, hemiGnd: 0xE8B060, hemiI: 0.60, fog: 0xDCC088 },
        { ambient: 0xFFCC80, ambientI: 0.55, dir: 0xFFD090, dirI: 2.0, hemiSky: 0x70A8D8, hemiGnd: 0xD09848, hemiI: 0.50, fog: 0xCCA868 },
        { ambient: 0xFF9944, ambientI: 0.50, dir: 0xFF7722, dirI: 1.8, hemiSky: 0xFF6633, hemiGnd: 0x996633, hemiI: 0.40, fog: 0xCC7744 },
        { ambient: 0x7755BB, ambientI: 0.40, dir: 0xDD5533, dirI: 1.2, hemiSky: 0x553377, hemiGnd: 0x664433, hemiI: 0.35, fog: 0x775566 },
        { ambient: 0x384466, ambientI: 0.35, dir: 0x6688CC, dirI: 0.9, hemiSky: 0x2A3858, hemiGnd: 0x2A2838, hemiI: 0.30, fog: 0x384466 },
        { ambient: 0x2E3E52, ambientI: 0.30, dir: 0x5577BB, dirI: 0.8, hemiSky: 0x1E2E44, hemiGnd: 0x1E1E30, hemiI: 0.25, fog: 0x2E3E52 },
        { ambient: 0x263848, ambientI: 0.28, dir: 0x4466AA, dirI: 0.7, hemiSky: 0x162838, hemiGnd: 0x141428, hemiI: 0.20, fog: 0x263848 },
    ];

    const tod = timeOfDay[Math.min(waveNum - 1, timeOfDay.length - 1)];
    ambientLight.color.setHex(tod.ambient);
    ambientLight.intensity = tod.ambientI;
    dirLight.color.setHex(tod.dir);
    dirLight.intensity = tod.dirI;
    hemiLight.color.setHex(tod.hemiSky);
    hemiLight.groundColor.setHex(tod.hemiGnd);
    hemiLight.intensity = tod.hemiI;
    if (scene.fog) scene.fog.color.setHex(tod.fog);
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
window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && gameManager.gameOver) restartGame();
    if (e.code === 'KeyM') soundManager.toggleMute();
    // ゲームオーバー時にSPACEでもリスタート
    if (e.code === 'Space' && gameManager.gameOver) restartGame();
});

function restartGame() {
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
    world.reset(scrollZ);
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
    const activeEffects = activeEntity.effects || [];
    while (activeEffects.length > 30) {
        const old = activeEffects.shift();
        if (old.destroy) old.destroy();
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
