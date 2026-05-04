import * as THREE from 'three';

/**
 * 爆発・マズルフラッシュエフェクト（STEP 7 強化版）
 * - 衝撃波リング
 * - 地面焦げ跡
 * - 改良パーティクルカラー
 * - 残煙効果
 * - PointLight最適化
 */

// 共有ジオメトリキャッシュ（パフォーマンス改善）
// 後半シーンでの大量爆発による Geometry/Material の生成→GC を抑える。
const _geoCache = {
    sphere_s:   new THREE.SphereGeometry(0.1, 6, 4),
    sphere_m:   new THREE.SphereGeometry(0.4, 8, 6),
    sphere_l:   new THREE.SphereGeometry(0.8, 10, 8),
    sphere_flame_s: new THREE.SphereGeometry(0.32, 6, 4),  // small explosion 用
    sphere_flame_l: new THREE.SphereGeometry(0.78, 6, 4),  // large explosion 用
    sphere_flame_m: new THREE.SphereGeometry(0.7, 7, 5),   // mega 用
    sphere_puff_s:  new THREE.SphereGeometry(0.22, 6, 4),  // クラスター用パフ
    sphere_puff_l:  new THREE.SphereGeometry(0.45, 6, 4),
    sphere_smoke_s: new THREE.SphereGeometry(0.45, 6, 4),
    sphere_smoke_l: new THREE.SphereGeometry(0.9, 6, 4),
    sphere_smoke_m: new THREE.SphereGeometry(1.2, 6, 4),
    sphere_ember:   new THREE.SphereGeometry(0.05, 4, 3),
    sphere_spark:   new THREE.SphereGeometry(0.04, 4, 3),
    box_debris_s:   new THREE.BoxGeometry(0.12, 0.12, 0.12),
    box_debris_l:   new THREE.BoxGeometry(0.2, 0.1, 0.2),
    box_debris_m:   new THREE.BoxGeometry(0.25, 0.12, 0.25),
    ring:           new THREE.RingGeometry(0.1, 1.0, 24),
    circle:         new THREE.CircleGeometry(1, 16),
    // muzzle 用（共有可能 — 色は material 側で個別に持たせる）
    sphere_halo:    new THREE.SphereGeometry(0.42, 8, 6),
    sphere_flash:   new THREE.SphereGeometry(0.25, 6, 4),
    sphere_inner:   new THREE.SphereGeometry(0.14, 6, 4),
    ring_muzzle:    new THREE.RingGeometry(0.12, 0.35, 16),
    shockwave:      new THREE.RingGeometry(0.1, 0.5, 32),
    // Metal Slug 風: 放射状フレーム・スパイク（先端が細い円錐）
    spike_flame:    new THREE.ConeGeometry(0.18, 1.0, 5, 1, true),
    // ロック/瓦礫（爆発後の地面に残る岩塊）
    rock_s:         new THREE.DodecahedronGeometry(0.18, 0),
    rock_m:         new THREE.DodecahedronGeometry(0.28, 0),
    // 焦げ跡: 半径ごとにキャッシュ（呼び出し側は 0.8 / 2.0 / 3.5）
    // 半径違いの CircleGeometry を毎爆発で生成すると後半 Wave で
    // 数百枚の Geometry がプール外に蓄積する。
    scorch_s:       new THREE.CircleGeometry(0.8, 16),
    scorch_m:       new THREE.CircleGeometry(2.0, 16),
    scorch_l:       new THREE.CircleGeometry(3.5, 16),
    // mega 爆発の中心核（毎メガ爆発で別 sphere を生成しないため共有）
    sphere_mega_core: new THREE.SphereGeometry(1.2, 10, 8),
};

// 同時に生成できる爆発由来 PointLight の数を制限（GPU 負荷上限）
const MAX_CONCURRENT_EXPLOSION_LIGHTS = 3;
let _activeExplosionLights = 0;

// 焦げ跡/岩塊の遅延 dispose 用 setTimeout 追跡。
// リセット (R) や全体破棄時に未発火の callback が残ると、scene から既に消えた mesh を
// 再度操作したり、過去ゲームのリソースが意図せず残るので、明示的にキャンセルできるよう保持する。
const _pendingExtraTimers = new Set();
export function cancelAllPendingExtraDisposals() {
    for (const tid of _pendingExtraTimers) clearTimeout(tid);
    _pendingExtraTimers.clear();
}

// リスタート時に爆発関連グローバル状態（ライトプール / アクティブカウンタ）を初期化する。
// これを呼ばないと、Game Over 時点で破棄しきれなかった爆発の light が _busy=true のまま残り、
// 次ゲームで _acquireLight が枯渇 → 新しい爆発が無灯化 → さらに古いライトが scene 上で
// 点きっぱなしになり、点滅・パフォーマンス低下の原因になる。
export function resetExplosionGlobals() {
    _activeExplosionLights = 0;
    for (const l of _lightPool) {
        l.intensity = 0;
        l.position.set(0, -1000, 0);
        l.userData._busy = false;
    }
}

// PointLight プール
// 爆発のたびに PointLight を add/remove するとシーンのライト数が変動し、
// three.js が全マテリアルのシェーダを再コンパイルする → 周辺オブジェクトが
// 1 フレーム消える/点滅する症状の原因になる。
// 固定数のライトをシーンに常駐させ intensity だけを切り替える方式に変更。
const _lightPool = [];
let _lightPoolScene = null;
function _ensureLightPool(scene) {
    if (_lightPoolScene === scene) return;
    // 既存プールを別シーンから外す
    for (const l of _lightPool) {
        if (l.parent) l.parent.remove(l);
    }
    _lightPool.length = 0;
    for (let i = 0; i < MAX_CONCURRENT_EXPLOSION_LIGHTS; i++) {
        const light = new THREE.PointLight(0xFF6600, 0, 35);
        light.position.set(0, -1000, 0); // 視野外に退避
        light.userData._busy = false;
        scene.add(light);
        _lightPool.push(light);
    }
    _lightPoolScene = scene;
}
function _acquireLight(scene, color, intensity, distance, position) {
    _ensureLightPool(scene);
    for (const l of _lightPool) {
        if (!l.userData._busy) {
            l.userData._busy = true;
            l.color.setHex(color);
            l.intensity = intensity;
            l.distance = distance;
            l.position.copy(position);
            return l;
        }
    }
    return null;
}
function _releaseLight(light) {
    if (!light) return;
    light.intensity = 0;
    light.position.set(0, -1000, 0);
    light.userData._busy = false;
}

export class Explosion {
    constructor(scene, position, {
        type = 'small',  // 'muzzle' | 'small' | 'large'
        color = 0xFF6600,
        residueLife = null,
    } = {}) {
        this.scene = scene;
        this.alive = true;
        this.age = 0;
        this.residueLife = residueLife;
        this.group = new THREE.Group();
        this.group.position.copy(position);
        this.particles = [];
        this.extras = []; // 追加エフェクト（衝撃波・焦げ跡）

        switch (type) {
            case 'muzzle':
                this.maxAge = 0.08;
                this._buildMuzzleFlash(color);
                break;
            case 'small':
                this.maxAge = 0.5;
                this._buildSmallExplosion();
                break;
            case 'large':
                this.maxAge = 1.0;
                this._buildLargeExplosion();
                break;
            case 'mega':
                this.maxAge = 0.9;
                this._buildMegaExplosion();
                break;
        }

        this.scene.add(this.group);
    }

    // ============================================
    // マズルフラッシュ（発砲炎）
    // 注: PointLight は撤去（寿命 0.08s で発射頻度が高くシェーダコストが支配的）。
    //     加算ブレンドの強い発光メッシュで視覚的には十分。
    //     ジオメトリは共有キャッシュ、マテリアルは色が引数次第なので個別生成。
    // ============================================
    _buildMuzzleFlash(color) {
        const halo = new THREE.Mesh(_geoCache.sphere_halo, new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.35,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        halo.scale.set(1.9, 1.3, 1.3);
        this.group.add(halo);
        this.particles.push({ mesh: halo, vx: 0, vy: 0, vz: 0, noGravity: true });

        const flash = new THREE.Mesh(_geoCache.sphere_flash, new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.98,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        flash.scale.set(1.8, 1.1, 1.1);
        this.group.add(flash);
        this.particles.push({ mesh: flash, vx: 0, vy: 0, vz: 0, noGravity: true });

        const inner = new THREE.Mesh(_geoCache.sphere_inner, new THREE.MeshBasicMaterial({
            color: 0xFFFFFF, transparent: true, opacity: 1.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        this.group.add(inner);
        this.particles.push({ mesh: inner, vx: 0, vy: 0, vz: 0, noGravity: true });

        const ring = new THREE.Mesh(_geoCache.ring_muzzle, new THREE.MeshBasicMaterial({
            color: 0xFFEEAA, transparent: true, opacity: 0.85,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        ring.rotation.y = Math.PI / 2;
        this.group.add(ring);
        this.particles.push({ mesh: ring, vx: 0, vy: 0, vz: 0, scale: 3.2, noGravity: true });

        // スパーク数を 4→2 に削減（連射時の累積負荷を軽減。視覚差は微小）
        for (let i = 0; i < 2; i++) {
            const spark = new THREE.Mesh(_geoCache.sphere_spark, new THREE.MeshBasicMaterial({
                color: 0xFFDD00, transparent: true, opacity: 0.9,
            }));
            this.group.add(spark);
            this.particles.push({
                mesh: spark,
                vx: (Math.random() - 0.5) * 9,
                vy: Math.random() * 4 + 1,
                vz: (Math.random() - 0.5) * 9,
            });
        }
    }

    // ============================================
    // 小爆発（歩兵撃破）
    // ============================================
    _buildSmallExplosion() {
        // ===== 中心核（白→黄色グラデーション） =====
        const coreGeo = _geoCache.sphere_m;
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xFFFFFF,
            transparent: true,
            opacity: 1.0,
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        this.group.add(core);
        this.particles.push({
            mesh: core, vx: 0, vy: 0.8, vz: 0,
            scale: 1.8,
            colorFade: true,
            startColor: new THREE.Color(0xFFFFFF),
            endColor: new THREE.Color(0xFF5500),
        });

        // ===== 炎球 x 5 =====
        for (let i = 0; i < 5; i++) {
            const flameMat = new THREE.MeshBasicMaterial({
                color: 0xFF8800,
                transparent: true,
                opacity: 0.95,
            });
            const flame = new THREE.Mesh(_geoCache.sphere_flame_s, flameMat);
            flame.scale.setScalar(0.85 + Math.random() * 0.5);
            const a = Math.random() * Math.PI * 2;
            flame.position.set(Math.cos(a) * 0.15, 0.1, Math.sin(a) * 0.15);
            this.group.add(flame);
            this.particles.push({
                mesh: flame,
                vx: Math.cos(a) * 2.8,
                vy: 1.8 + Math.random() * 2.5,
                vz: Math.sin(a) * 2.8,
                scale: 1.6,
                colorFade: true,
                startColor: new THREE.Color(0xFFCC00),
                endColor: new THREE.Color(0x441100),
            });
        }

        // ===== 飛散パーティクル x 8（10→8: 視覚差は微小） =====
        const debrisColors = [0xFF5500, 0xFF8800, 0xFFBB00, 0xFFDD33, 0xFFFF66, 0x444444];
        for (let i = 0; i < 8; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: debrisColors[Math.floor(Math.random() * debrisColors.length)],
                transparent: true,
                opacity: 1.0,
            });
            const particle = new THREE.Mesh(_geoCache.box_debris_s, mat);
            particle.scale.setScalar(0.6 + Math.random() * 1.0);
            this.group.add(particle);

            const angle = Math.random() * Math.PI * 2;
            const upAngle = Math.random() * Math.PI * 0.5;
            const speed = 4 + Math.random() * 7;
            this.particles.push({
                mesh: particle,
                vx: Math.cos(angle) * Math.sin(upAngle) * speed,
                vy: Math.cos(upAngle) * speed + 2,
                vz: Math.sin(angle) * Math.sin(upAngle) * speed,
                rotSpeed: (Math.random() - 0.5) * 18,
            });
        }

        // ===== 煙 x 3 =====
        for (let i = 0; i < 3; i++) {
            const smokeMat = new THREE.MeshBasicMaterial({
                color: 0x444444,
                transparent: true,
                opacity: 0.5,
            });
            const smoke = new THREE.Mesh(_geoCache.sphere_smoke_s, smokeMat);
            smoke.scale.setScalar(0.7 + Math.random() * 0.7);
            this.group.add(smoke);
            this.particles.push({
                mesh: smoke,
                vx: (Math.random() - 0.5) * 1.5,
                vy: 0.8 + Math.random() * 1.5,
                vz: (Math.random() - 0.5) * 1.5,
                scale: 2.5,
                fadeDelay: 0.3,
                noGravity: true,
            });
        }

        // ===== Metal Slug 風 放射スパイクフレーム x 6 =====
        this._addSpikeStreaks({ count: 6, length: 1.6, thickness: 0.55, tilt: 0.2 });

        // ===== クラスター・パフ（モコモコ感） x 4 =====
        this._addPuffCluster({ count: 4, geo: _geoCache.sphere_puff_s, radius: 0.5, color: 0xFFAA22 });

        // ===== 小さな岩塊（地面に残る瓦礫） x 3 =====
        this._addRockPile({ count: 3, geo: _geoCache.rock_s, spread: 0.6 });

        // ===== 地面の焦げ跡 =====
        this._addGroundScorch(0.8);

        // PointLight（プールから取得。シェーダ再コンパイルを避けるため add/remove はしない）
        if (_activeExplosionLights < MAX_CONCURRENT_EXPLOSION_LIGHTS) {
            const light = _acquireLight(this.scene, 0xFF6600, 4, 12, this.group.position);
            if (light) {
                this.flashLight = light;
                _activeExplosionLights++;
            }
        }
    }

    // ============================================
    // 大爆発（戦車・航空機撃破）
    // ============================================
    _buildLargeExplosion() {
        // ===== 中心核（白い閃光） =====
        const coreGeo = _geoCache.sphere_l;
        const coreMat = new THREE.MeshBasicMaterial({
            color: 0xFFFFFF,
            transparent: true,
            opacity: 1.0,
        });
        const core = new THREE.Mesh(coreGeo, coreMat);
        this.group.add(core);
        this.particles.push({
            mesh: core, vx: 0, vy: 1.5, vz: 0,
            scale: 2.5,
            colorFade: true,
            startColor: new THREE.Color(0xFFFFFF),
            endColor: new THREE.Color(0xFF3300),
        });

        // ===== 衝撃波リング =====
        this._addShockwave();

        // ===== 外殻の炎球 x 8 =====
        for (let i = 0; i < 8; i++) {
            const flameMat = new THREE.MeshBasicMaterial({
                color: 0xFF7700,
                transparent: true,
                opacity: 0.9,
            });
            const flame = new THREE.Mesh(_geoCache.sphere_flame_l, flameMat);
            flame.scale.setScalar(0.7 + Math.random() * 0.6);
            const a = Math.random() * Math.PI * 2;
            flame.position.set(Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3);
            this.group.add(flame);
            this.particles.push({
                mesh: flame,
                vx: Math.cos(a) * 4.0,
                vy: 2.5 + Math.random() * 3.5,
                vz: Math.sin(a) * 4.0,
                scale: 2.2,
                colorFade: true,
                startColor: new THREE.Color(0xFFDD00),
                endColor: new THREE.Color(0x330000),
            });
        }

        // ===== 飛散破片 x 14（20→14: 視覚密度は維持） =====
        const colors = [0xFF4400, 0xFF6600, 0xFFAA00, 0xFFDD00, 0xFFFF44, 0x444444, 0x666666];
        for (let i = 0; i < 14; i++) {
            const mat = new THREE.MeshBasicMaterial({
                color: colors[Math.floor(Math.random() * colors.length)],
                transparent: true,
                opacity: 1.0,
            });
            const piece = new THREE.Mesh(_geoCache.box_debris_l, mat);
            piece.scale.setScalar(0.6 + Math.random() * 1.6);
            this.group.add(piece);

            const angle = Math.random() * Math.PI * 2;
            const upAngle = Math.random() * Math.PI * 0.45;
            const speed = 5 + Math.random() * 12;
            this.particles.push({
                mesh: piece,
                vx: Math.cos(angle) * Math.sin(upAngle) * speed,
                vy: Math.cos(upAngle) * speed + 3,
                vz: Math.sin(angle) * Math.sin(upAngle) * speed,
                rotSpeed: (Math.random() - 0.5) * 22,
            });
        }

        // ===== エンバー（残り火の火花） x 8（12→8） =====
        for (let i = 0; i < 8; i++) {
            const emberMat = new THREE.MeshBasicMaterial({
                color: 0xFFAA00,
                transparent: true,
                opacity: 1.0,
            });
            const ember = new THREE.Mesh(_geoCache.sphere_ember, emberMat);
            ember.scale.setScalar(0.6 + Math.random() * 0.8);
            this.group.add(ember);
            this.particles.push({
                mesh: ember,
                vx: (Math.random() - 0.5) * 6,
                vy: 4 + Math.random() * 8,
                vz: (Math.random() - 0.5) * 6,
                isEmber: true,
                colorFade: true,
                startColor: new THREE.Color(0xFFDD44),
                endColor: new THREE.Color(0xFF2200),
            });
        }

        // ===== 煙（残煙 - 長く残る） x 4（6→4） =====
        for (let i = 0; i < 4; i++) {
            const smokeMat = new THREE.MeshBasicMaterial({
                color: i < 2 ? 0x444444 : 0x222222,
                transparent: true,
                opacity: 0.6,
            });
            const smoke = new THREE.Mesh(_geoCache.sphere_smoke_l, smokeMat);
            smoke.scale.setScalar(0.7 + Math.random() * 0.7);
            this.group.add(smoke);
            this.particles.push({
                mesh: smoke,
                vx: (Math.random() - 0.5) * 2,
                vy: 1.5 + Math.random() * 2.5,
                vz: (Math.random() - 0.5) * 2,
                scale: 3.5,
                fadeDelay: 0.25,
                noGravity: true,
            });
        }

        // ===== Metal Slug 風 放射スパイクフレーム x 10（大爆発は本数多め） =====
        this._addSpikeStreaks({ count: 10, length: 3.0, thickness: 0.85, tilt: 0.25 });

        // ===== クラスター・パフ（モコモコの炎雲） x 7 =====
        this._addPuffCluster({ count: 7, geo: _geoCache.sphere_puff_l, radius: 1.0, color: 0xFFCC33 });
        this._addPuffCluster({ count: 5, geo: _geoCache.sphere_puff_l, radius: 1.4, color: 0xFF6611, vy: 1.2 });

        // ===== 岩塊・コンクリ瓦礫（地面に残る） x 6 =====
        this._addRockPile({ count: 6, geo: _geoCache.rock_m, spread: 1.4 });

        // ===== 地面の焦げ跡 =====
        this._addGroundScorch(2.0);

        // 強い PointLight（プールから取得）
        if (_activeExplosionLights < MAX_CONCURRENT_EXPLOSION_LIGHTS) {
            const light = _acquireLight(this.scene, 0xFF4400, 6, 25, this.group.position);
            if (light) {
                this.flashLight = light;
                _activeExplosionLights++;
            }
        }
    }

    // ============================================
    // Feature 6: 巨大手榴弾爆発 (mega)
    // ============================================
    _buildMegaExplosion() {
        // コア - 巨大白色（共有ジオメトリ使用）
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
        const core = new THREE.Mesh(_geoCache.sphere_mega_core, coreMat);
        this.group.add(core);
        this.particles.push({ mesh: core, vx: 0, vy: 0.5, vz: 0, scale: 3.0, noGravity: true, colorFade: true, startColor: new THREE.Color(0xFFFFFF), endColor: new THREE.Color(0xFF2200) });

        // 炎球 x 10（12→10）
        for (let i = 0; i < 10; i++) {
            const flameMat = new THREE.MeshBasicMaterial({ color: 0xFF6600, transparent: true, opacity: 0.9 });
            const flame = new THREE.Mesh(_geoCache.sphere_flame_m, flameMat);
            flame.scale.setScalar(0.7 + Math.random() * 0.6);
            const a = Math.random() * Math.PI * 2;
            flame.position.set(Math.cos(a) * 0.4, 0.2, Math.sin(a) * 0.4);
            this.group.add(flame);
            this.particles.push({ mesh: flame, vx: Math.cos(a) * 5.5, vy: 3 + Math.random() * 5, vz: Math.sin(a) * 5.5, scale: 2.5, colorFade: true, startColor: new THREE.Color(0xFFCC00), endColor: new THREE.Color(0x330000) });
        }

        // 破片 x 20（30→20）
        const colors = [0xFF4400, 0xFF8800, 0xFFCC00, 0x555555, 0x222222];
        for (let i = 0; i < 20; i++) {
            const mat = new THREE.MeshBasicMaterial({ color: colors[Math.floor(Math.random() * colors.length)], transparent: true, opacity: 1.0 });
            const piece = new THREE.Mesh(_geoCache.box_debris_m, mat);
            piece.scale.setScalar(0.6 + Math.random() * 1.5);
            this.group.add(piece);
            const angle = Math.random() * Math.PI * 2;
            const upAngle = Math.random() * Math.PI * 0.5;
            const speed = 7 + Math.random() * 16;
            this.particles.push({ mesh: piece, vx: Math.cos(angle) * Math.sin(upAngle) * speed, vy: Math.cos(upAngle) * speed + 5, vz: Math.sin(angle) * Math.sin(upAngle) * speed, rotSpeed: (Math.random() - 0.5) * 28 });
        }

        // 煙柱 x 6（8→6）
        for (let i = 0; i < 6; i++) {
            const smokeMat = new THREE.MeshBasicMaterial({ color: i < 3 ? 0x333333 : 0x111111, transparent: true, opacity: 0.65 });
            const smoke = new THREE.Mesh(_geoCache.sphere_smoke_m, smokeMat);
            smoke.scale.setScalar(0.7 + Math.random() * 0.7);
            this.group.add(smoke);
            this.particles.push({ mesh: smoke, vx: (Math.random() - 0.5) * 3, vy: 2.5 + Math.random() * 4, vz: (Math.random() - 0.5) * 3, scale: 5.0, fadeDelay: 0.15, noGravity: true });
        }

        // ===== Metal Slug 風 巨大放射スパイク x 14 =====
        this._addSpikeStreaks({ count: 14, length: 4.2, thickness: 1.1, tilt: 0.3 });

        // ===== 多層クラスター・パフ（巨大なキノコ雲の輪郭） =====
        this._addPuffCluster({ count: 10, geo: _geoCache.sphere_puff_l, radius: 1.4, color: 0xFFDD55 });
        this._addPuffCluster({ count: 8, geo: _geoCache.sphere_puff_l, radius: 2.0, color: 0xFF7722, vy: 1.5 });
        this._addPuffCluster({ count: 6, geo: _geoCache.sphere_puff_l, radius: 2.6, color: 0x553322, vy: 2.4 });

        // ===== 大量の岩塊・瓦礫の山 =====
        this._addRockPile({ count: 10, geo: _geoCache.rock_m, spread: 2.4 });

        // 二重衝撃波
        this._addShockwave();
        this._addGroundScorch(3.5);

        if (_activeExplosionLights < MAX_CONCURRENT_EXPLOSION_LIGHTS) {
            const light = _acquireLight(this.scene, 0xFF6600, 10, 35, this.group.position);
            if (light) {
                this.flashLight = light;
                _activeExplosionLights++;
            }
        }
    }

    // ============================================
    // Metal Slug 風 放射スパイクフレーム
    // 中心から外向きに伸びる先細りの炎ジェット。爆発の象徴的シルエット。
    // ============================================
    _addSpikeStreaks({ count = 8, length = 2.0, thickness = 0.6, tilt = 0.2 } = {}) {
        for (let i = 0; i < count; i++) {
            const baseAngle = (i / count) * Math.PI * 2 + Math.random() * 0.2;
            const upTilt = (Math.random() - 0.5) * tilt;
            const lenScale = length * (0.7 + Math.random() * 0.6);
            const thickScale = thickness * (0.7 + Math.random() * 0.6);

            // 内側コア（明るい黄白）
            const inner = new THREE.Mesh(
                _geoCache.spike_flame,
                new THREE.MeshBasicMaterial({
                    color: 0xFFEE88,
                    transparent: true,
                    opacity: 1.0,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                })
            );
            // 円錐は +Y が先端 → 横向きに倒す
            inner.rotation.z = Math.PI / 2;
            // ピボットを爆発中心に置き、円錐を中心から放射方向に伸ばす
            const pivot = new THREE.Group();
            pivot.position.set(0, 0.4 + upTilt * 0.5, 0);
            pivot.rotation.y = baseAngle;
            pivot.rotation.z = upTilt;
            inner.position.x = lenScale * 0.5; // 先端を外側に
            inner.scale.set(lenScale, thickScale * 0.55, thickScale * 0.55);
            pivot.add(inner);

            // 外側のオレンジハロー（厚みを足す）
            const outer = new THREE.Mesh(
                _geoCache.spike_flame,
                new THREE.MeshBasicMaterial({
                    color: 0xFF6611,
                    transparent: true,
                    opacity: 0.85,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                })
            );
            outer.rotation.z = Math.PI / 2;
            outer.position.x = lenScale * 0.55;
            outer.scale.set(lenScale * 1.05, thickScale, thickScale);
            pivot.add(outer);

            this.group.add(pivot);

            // 伸長アニメ用パーティクル登録
            this.particles.push({
                mesh: pivot,
                vx: 0, vy: 0, vz: 0,
                noGravity: true,
                isSpike: true,
                startScaleX: 0.15,
                endScaleX: 1.0,
                inner, outer,
                innerLen: lenScale,
                outerLen: lenScale * 1.05,
                startColor: new THREE.Color(0xFFEE88),
                endColor: new THREE.Color(0x331100),
            });
        }
    }

    // ============================================
    // クラスター・パフ（モコモコのキノコ雲シルエット）
    // ============================================
    _addPuffCluster({ count = 5, geo, radius = 0.8, color = 0xFFAA22, vy = 0.8 } = {}) {
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = radius * (0.4 + Math.random() * 0.7);
            const yOff = Math.random() * radius * 0.8;
            const mat = new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.92,
            });
            const puff = new THREE.Mesh(geo, mat);
            puff.position.set(Math.cos(a) * r, yOff, Math.sin(a) * r);
            puff.scale.setScalar(0.7 + Math.random() * 0.7);
            this.group.add(puff);
            this.particles.push({
                mesh: puff,
                vx: Math.cos(a) * (1.0 + Math.random() * 1.5),
                vy: vy + Math.random() * 1.2,
                vz: Math.sin(a) * (1.0 + Math.random() * 1.5),
                scale: 1.8,
                noGravity: true,
                colorFade: true,
                startColor: new THREE.Color(color),
                endColor: new THREE.Color(0x221100),
                fadeDelay: 0.15,
            });
        }
    }

    // ============================================
    // 岩塊・瓦礫の山（地面に残るチャンク）
    // 注: 岩は爆発グループの寿命より長く残したいので、scene 直下に置いて
    //     extras 経由で個別に setTimeout 解放する（焦げ跡と同じ方式）。
    // ============================================
    _addRockPile({ count = 4, geo, spread = 1.0 } = {}) {
        const rockColors = [0x555555, 0x444444, 0x6a5a48, 0x4a3a2a, 0x333333];
        const worldPos = this.group.position;
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = spread * (0.2 + Math.random() * 0.9);
            const mat = new THREE.MeshLambertMaterial({
                color: rockColors[Math.floor(Math.random() * rockColors.length)],
            });
            const rock = new THREE.Mesh(geo, mat);
            rock.scale.setScalar(0.8 + Math.random() * 1.4);
            rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            // ワールド座標に直接配置
            rock.position.set(
                worldPos.x + Math.cos(a) * r * 0.3,
                worldPos.y + 0.6 + Math.random() * 0.5,
                worldPos.z + Math.sin(a) * r * 0.3
            );
            this.scene.add(rock);

            // シンプルな放物運動 → 着地で停止する自走パーティクル
            this.extras.push({
                type: 'rock',
                mesh: rock,
                scene: this.scene,
                vx: Math.cos(a) * (1.5 + Math.random() * 2.5),
                vy: 1.5 + Math.random() * 2.5,
                vz: Math.sin(a) * (1.5 + Math.random() * 2.5),
                rotSpeed: (Math.random() - 0.5) * 8,
                groundY: 0.08,
                resting: false,
                lifeTimer: this.residueLife !== null ? this.residueLife : 4.0, // 一定時間後に削除
                lifeAge: 0,     // 経過時間を追跡
            });
        }
    }

    // ============================================
    // 衝撃波リング
    // ============================================
    _addShockwave() {
        const shockwaveMat = new THREE.MeshBasicMaterial({
            color: 0xFFDD88,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const shockwave = new THREE.Mesh(_geoCache.shockwave, shockwaveMat);
        shockwave.rotation.x = -Math.PI / 2;
        shockwave.position.y = 0.1;
        this.group.add(shockwave);

        this.extras.push({
            type: 'shockwave',
            mesh: shockwave,
            expandSpeed: 15,
            maxScale: 8,
        });
    }

    // ============================================
    // 地面の焦げ跡
    // ============================================
    _addGroundScorch(radius) {
        // 共有ジオメトリ: 呼び出し側半径に対応する _geoCache を選択。
        // 半径ベースの Circle を毎爆発で生成・dispose すると後半シーンで
        // GPU バッファの fragmentation と GC pressure が積もる。
        let scorchGeo;
        if (radius <= 1.0)        scorchGeo = _geoCache.scorch_s; // 0.8 用
        else if (radius <= 2.5)   scorchGeo = _geoCache.scorch_m; // 2.0 用
        else                      scorchGeo = _geoCache.scorch_l; // 3.5 用
        const scorchMat = new THREE.MeshBasicMaterial({
            color: 0x111111,
            transparent: true,
            opacity: 0.35,
            side: THREE.DoubleSide,
        });
        const scorch = new THREE.Mesh(scorchGeo, scorchMat);
        scorch.rotation.x = -Math.PI / 2;
        // 爆発のワールド位置に直接配置
        const worldPos = this.group.position.clone();
        scorch.position.set(worldPos.x, 0.03, worldPos.z);
        this.scene.add(scorch);

        this.extras.push({
            type: 'scorch',
            mesh: scorch,
            fadeTimer: this.residueLife !== null ? this.residueLife : 5.0, // 一定時間後にフェードアウト
            fadeAge: 0,     // 経過時間を追跡
            scene: this.scene,
        });
    }

    // ============================================
    // 更新
    // ============================================
    update(dt) {
        if (!this.alive) return;

        this.age += dt;
        const progress = this.age / this.maxAge;

        if (progress >= 1) {
            this.destroy();
            return;
        }

        // パーティクル更新
        this.particles.forEach(p => {
            // 移動
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;

            // 重力
            if (!p.noGravity) {
                p.vy -= 9.8 * dt;
            }

            // 回転
            if (p.rotSpeed) {
                p.mesh.rotation.x += p.rotSpeed * dt;
                p.mesh.rotation.z += p.rotSpeed * dt * 0.7;
            }

            // スパイク: 中心から放射状に伸びるアニメ
            if (p.isSpike) {
                const t = Math.min(1, progress * 2.5); // 最初の 40% で伸び切る
                const grow = p.startScaleX + (p.endScaleX - p.startScaleX) * t;
                if (p.inner) p.inner.scale.set(p.innerLen * grow, p.inner.scale.y, p.inner.scale.z);
                if (p.outer) p.outer.scale.set(p.outerLen * grow, p.outer.scale.y, p.outer.scale.z);
                // カラーフェード（黄→暗赤）
                const cFade = p.startColor.clone().lerp(p.endColor, progress);
                if (p.outer) p.outer.material.color.copy(cFade);
            }

            // スケール拡大（スパイク以外）
            if (p.scale && !p.isSpike) {
                const s = 1 + (p.scale - 1) * progress;
                p.mesh.scale.setScalar(s);
            }

            // カラーフェード
            if (p.colorFade && p.startColor && p.endColor && !p.isSpike) {
                const c = p.startColor.clone().lerp(p.endColor, progress);
                p.mesh.material.color.copy(c);
            }

            // フェードアウト
            const fadeStart = p.fadeDelay || 0;
            const fadeProgress = Math.max(0, (progress - fadeStart) / (1 - fadeStart));
            if (p.isSpike) {
                // スパイクは前半で強く出て後半で素早く消える
                const op = progress < 0.3 ? 1.0 : Math.max(0, 1 - (progress - 0.3) / 0.7);
                if (p.inner) p.inner.material.opacity = op;
                if (p.outer) p.outer.material.opacity = op * 0.85;
            } else if (p.mesh.material && p.mesh.material.transparent) {
                p.mesh.material.opacity = Math.max(0, 1 - fadeProgress);
            }

            // エンバー: ランダムな明滅
            if (p.isEmber) {
                p.mesh.material.opacity = Math.max(0, (1 - progress) * (0.5 + Math.random() * 0.5));
            }
        });

        // 衝撃波・岩塊・焦げ跡などの更新
        this.extras.forEach(e => {
            if (e.type === 'shockwave') {
                const s = 1 + e.expandSpeed * this.age;
                if (s < e.maxScale) {
                    e.mesh.scale.setScalar(s);
                    e.mesh.material.opacity = Math.max(0, 0.7 * (1 - s / e.maxScale));
                } else {
                    e.mesh.visible = false;
                }
            } else if (e.type === 'rock') {
                if (!e.resting) {
                    // 放物運動
                    e.mesh.position.x += e.vx * dt;
                    e.mesh.position.y += e.vy * dt;
                    e.mesh.position.z += e.vz * dt;
                    e.vy -= 9.8 * dt;
                    e.mesh.rotation.x += e.rotSpeed * dt;
                    e.mesh.rotation.z += e.rotSpeed * dt * 0.7;
                    if (e.mesh.position.y <= e.groundY) {
                        e.mesh.position.y = e.groundY;
                        e.vx *= 0.25;
                        e.vz *= 0.25;
                        e.vy = 0;
                        e.rotSpeed = 0;
                        e.resting = true;
                    }
                }
                // 岩塊の徐々なフェードアウト（残り2秒でフェード開始）
                if (e.lifeAge !== undefined) {
                    e.lifeAge += dt;
                    const fadeStart = Math.max(0, e.lifeTimer - 2.0);
                    if (e.lifeAge > fadeStart) {
                        const fadeProgress = (e.lifeAge - fadeStart) / 2.0;
                        const scale = Math.max(0, 1 - fadeProgress * 0.6);
                        e.mesh.scale.multiplyScalar(1 - dt * 0.4);
                        if (e.mesh.material && e.mesh.material.transparent !== undefined) {
                            e.mesh.material.transparent = true;
                            e.mesh.material.opacity = Math.max(0, 1 - fadeProgress);
                        }
                    }
                }
            } else if (e.type === 'scorch') {
                // 焦げ跡の徐々なフェードアウト
                if (e.fadeAge !== undefined) {
                    e.fadeAge += dt;
                    const fadeStart = Math.max(0, e.fadeTimer - 2.5);
                    if (e.fadeAge > fadeStart) {
                        const fadeProgress = (e.fadeAge - fadeStart) / 2.5;
                        if (e.mesh.material) {
                            e.mesh.material.opacity = Math.max(0, 0.35 * (1 - fadeProgress));
                        }
                    }
                }
            }
        });

        // ライトの減衰（プール光源のためグループ位置を追従）
        if (this.flashLight) {
            this.flashLight.position.copy(this.group.position);
            this.flashLight.intensity *= (1 - dt * 6);
            if (this.flashLight.intensity < 0.05) {
                _releaseLight(this.flashLight);
                this.flashLight = null;
                _activeExplosionLights = Math.max(0, _activeExplosionLights - 1);
            }
        }
    }

    destroy() {
        const hasLivePayload = !!(this.group && this.group.parent) || this.extras.length > 0 || !!this.flashLight;
        if (!this.alive && !hasLivePayload) return;
        this.alive = false;
        // ライトをプールに返却
        if (this.flashLight) {
            _releaseLight(this.flashLight);
            this.flashLight = null;
            _activeExplosionLights = Math.max(0, _activeExplosionLights - 1);
        }
        if (this.group && this.group.parent) this.scene.remove(this.group);
        const cachedGeoms = Object.values(_geoCache);
        this.group.traverse(child => {
            if (child.isMesh) {
                // 共有ジオメトリは破棄しない
                if (child.geometry && !cachedGeoms.includes(child.geometry)) {
                    child.geometry.dispose();
                }
                if (child.material) child.material.dispose();
            }
            // プール光源は dispose しない（シーン常駐）
        });

        // 焦げ跡・岩塊のクリーンアップ: 爆発グループ寿命より長く残すため scene 直下
        // 即座にフェードアウトアニメーションを開始し、一定時間後に完全除去
        const cachedGeomList = Object.values(_geoCache);
        this.extras.forEach(e => {
            const mesh = e.mesh;
            if (!mesh) return;

            // フェードアウトの開始タイミングと持続時間を計算
            const totalLife = e.type === 'scorch'
                ? Math.min(e.fadeTimer || 5, 5)  // 最大5秒
                : Math.min(e.lifeTimer || 4, 4); // 最大4秒
            const fadeStartDelay = Math.max(0, (totalLife - 2.0)) * 1000; // 最後の2秒でフェードアウト
            const fadeDuration = 2000; // 2秒かけてフェードアウト

            // フェードアウトアニメーション（setIntervalでscene外でも動作）
            let fadeTimerId;
            fadeTimerId = setTimeout(() => {
                _pendingExtraTimers.delete(fadeTimerId);
                const fadeStart = performance.now();
                const startOpacity = mesh.material ? (mesh.material.opacity || 1.0) : 1.0;
                let animId;
                animId = setInterval(() => {
                    const elapsed = performance.now() - fadeStart;
                    const t = Math.min(1, elapsed / fadeDuration);
                    if (mesh.material) {
                        mesh.material.transparent = true;
                        mesh.material.opacity = startOpacity * (1 - t);
                    }
                    if (e.type === 'rock') {
                        const s = Math.max(0.01, 1 - t * 0.8);
                        mesh.scale.setScalar(s);
                    }
                    if (t >= 1) {
                        clearInterval(animId);
                        _pendingExtraTimers.delete(animId);
                    }
                }, 50);
                _pendingExtraTimers.add(animId);
            }, fadeStartDelay);
            _pendingExtraTimers.add(fadeTimerId);

            // 最終的な強制除去（フェードアウト完了後）
            const totalDelay = fadeStartDelay + fadeDuration + 200;
            let tid;
            tid = setTimeout(() => {
                _pendingExtraTimers.delete(tid);
                if (mesh.parent) mesh.parent.remove(mesh);
                if (mesh.geometry && !cachedGeomList.includes(mesh.geometry)) {
                    mesh.geometry.dispose();
                }
                if (mesh.material) {
                    if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
                    else mesh.material.dispose();
                }
            }, totalDelay);
            _pendingExtraTimers.add(tid);
        });
        this.extras.length = 0;
    }
}
