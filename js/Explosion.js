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
const _geoCache = {
    sphere_s: new THREE.SphereGeometry(0.1, 6, 4),
    sphere_m: new THREE.SphereGeometry(0.4, 8, 6),
    sphere_l: new THREE.SphereGeometry(0.8, 10, 8),
    box_s: null,
    ring: new THREE.RingGeometry(0.1, 1.0, 24),
    circle: new THREE.CircleGeometry(1, 16),
};

export class Explosion {
    constructor(scene, position, {
        type = 'small',  // 'muzzle' | 'small' | 'large'
        color = 0xFF6600,
    } = {}) {
        this.scene = scene;
        this.alive = true;
        this.age = 0;
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
    // ============================================
    _buildMuzzleFlash(color) {
        // 外側のハロー（大きく暗め、ブルーム感）
        const haloGeo = new THREE.SphereGeometry(0.42, 8, 6);
        const haloMat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.35,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const halo = new THREE.Mesh(haloGeo, haloMat);
        halo.scale.set(1.9, 1.3, 1.3);
        this.group.add(halo);
        // 注: p.scale を指定すると setScalar で初期スケールが上書きされるため、指定しない
        this.particles.push({ mesh: halo, vx: 0, vy: 0, vz: 0, noGravity: true });

        // 方向性のあるフラッシュ（コーン型）
        const flashGeo = new THREE.SphereGeometry(0.25, 6, 4);
        const flashMat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.98,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const flash = new THREE.Mesh(flashGeo, flashMat);
        flash.scale.set(1.8, 1.1, 1.1);
        this.group.add(flash);
        this.particles.push({ mesh: flash, vx: 0, vy: 0, vz: 0, noGravity: true });

        // 内側の白い光
        const innerGeo = new THREE.SphereGeometry(0.14, 6, 4);
        const innerMat = new THREE.MeshBasicMaterial({
            color: 0xFFFFFF,
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const inner = new THREE.Mesh(innerGeo, innerMat);
        this.group.add(inner);
        this.particles.push({ mesh: inner, vx: 0, vy: 0, vz: 0, noGravity: true });

        // 放射リング（一瞬だけ輝く）
        const ringGeo = new THREE.RingGeometry(0.12, 0.35, 16);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xFFEEAA,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.y = Math.PI / 2;
        this.group.add(ring);
        this.particles.push({ mesh: ring, vx: 0, vy: 0, vz: 0, scale: 3.2, noGravity: true });

        // 小さなスパーク（4個飛散）
        for (let i = 0; i < 4; i++) {
            const sparkGeo = new THREE.SphereGeometry(0.04, 4, 3);
            const sparkMat = new THREE.MeshBasicMaterial({
                color: 0xFFDD00,
                transparent: true,
                opacity: 0.9,
            });
            const spark = new THREE.Mesh(sparkGeo, sparkMat);
            this.group.add(spark);
            this.particles.push({
                mesh: spark,
                vx: (Math.random() - 0.5) * 9,
                vy: Math.random() * 4 + 1,
                vz: (Math.random() - 0.5) * 9,
            });
        }

        // PointLight（短い寿命、強め）
        const light = new THREE.PointLight(color, 4.5, 7);
        this.group.add(light);
        this.flashLight = light;
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
            const flameGeo = new THREE.SphereGeometry(0.25 + Math.random() * 0.18, 6, 4);
            const flameMat = new THREE.MeshBasicMaterial({
                color: 0xFF8800,
                transparent: true,
                opacity: 0.95,
            });
            const flame = new THREE.Mesh(flameGeo, flameMat);
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

        // ===== 飛散パーティクル x 10 =====
        const debrisColors = [0xFF5500, 0xFF8800, 0xFFBB00, 0xFFDD33, 0xFFFF66, 0x444444];
        for (let i = 0; i < 10; i++) {
            const size = 0.06 + Math.random() * 0.12;
            const geo = new THREE.BoxGeometry(size, size, size);
            const mat = new THREE.MeshBasicMaterial({
                color: debrisColors[Math.floor(Math.random() * debrisColors.length)],
                transparent: true,
                opacity: 1.0,
            });
            const particle = new THREE.Mesh(geo, mat);
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
            const smokeGeo = new THREE.SphereGeometry(0.3 + Math.random() * 0.3, 6, 4);
            const smokeMat = new THREE.MeshBasicMaterial({
                color: 0x444444,
                transparent: true,
                opacity: 0.5,
            });
            const smoke = new THREE.Mesh(smokeGeo, smokeMat);
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

        // ===== 地面の焦げ跡 =====
        this._addGroundScorch(0.8);

        // PointLight
        const light = new THREE.PointLight(0xFF6600, 4, 12);
        this.group.add(light);
        this.flashLight = light;
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
            const flameGeo = new THREE.SphereGeometry(0.55 + Math.random() * 0.45, 6, 4);
            const flameMat = new THREE.MeshBasicMaterial({
                color: 0xFF7700,
                transparent: true,
                opacity: 0.9,
            });
            const flame = new THREE.Mesh(flameGeo, flameMat);
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

        // ===== 飛散破片 x 20 =====
        const colors = [0xFF4400, 0xFF6600, 0xFFAA00, 0xFFDD00, 0xFFFF44, 0x444444, 0x666666];
        for (let i = 0; i < 20; i++) {
            const size = 0.1 + Math.random() * 0.25;
            const geo = new THREE.BoxGeometry(size, size * 0.5, size);
            const mat = new THREE.MeshBasicMaterial({
                color: colors[Math.floor(Math.random() * colors.length)],
                transparent: true,
                opacity: 1.0,
            });
            const piece = new THREE.Mesh(geo, mat);
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

        // ===== エンバー（残り火の火花） x 12 =====
        for (let i = 0; i < 12; i++) {
            const emberGeo = new THREE.SphereGeometry(0.03 + Math.random() * 0.04, 4, 3);
            const emberMat = new THREE.MeshBasicMaterial({
                color: 0xFFAA00,
                transparent: true,
                opacity: 1.0,
            });
            const ember = new THREE.Mesh(emberGeo, emberMat);
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

        // ===== 煙（残煙 - 長く残る） x 6 =====
        for (let i = 0; i < 6; i++) {
            const smokeGeo = new THREE.SphereGeometry(0.6 + Math.random() * 0.6, 6, 4);
            const smokeMat = new THREE.MeshBasicMaterial({
                color: i < 3 ? 0x444444 : 0x222222,
                transparent: true,
                opacity: 0.6,
            });
            const smoke = new THREE.Mesh(smokeGeo, smokeMat);
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

        // ===== 地面の焦げ跡 =====
        this._addGroundScorch(2.0);

        // 強いPointLight
        const light = new THREE.PointLight(0xFF4400, 6, 25);
        this.group.add(light);
        this.flashLight = light;
    }

    // ============================================
    // Feature 6: 巨大手榴弾爆発 (mega)
    // ============================================
    _buildMegaExplosion() {
        // コア - 巨大白色
        const coreGeo = new THREE.SphereGeometry(1.2, 10, 8);
        const coreMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
        const core = new THREE.Mesh(coreGeo, coreMat);
        this.group.add(core);
        this.particles.push({ mesh: core, vx: 0, vy: 0.5, vz: 0, scale: 3.0, noGravity: true, colorFade: true, startColor: new THREE.Color(0xFFFFFF), endColor: new THREE.Color(0xFF2200) });

        // 炎球 x 12
        for (let i = 0; i < 12; i++) {
            const flameGeo = new THREE.SphereGeometry(0.5 + Math.random() * 0.4, 7, 5);
            const flameMat = new THREE.MeshBasicMaterial({ color: 0xFF6600, transparent: true, opacity: 0.9 });
            const flame = new THREE.Mesh(flameGeo, flameMat);
            const a = Math.random() * Math.PI * 2;
            flame.position.set(Math.cos(a) * 0.4, 0.2, Math.sin(a) * 0.4);
            this.group.add(flame);
            this.particles.push({ mesh: flame, vx: Math.cos(a) * 5.5, vy: 3 + Math.random() * 5, vz: Math.sin(a) * 5.5, scale: 2.5, colorFade: true, startColor: new THREE.Color(0xFFCC00), endColor: new THREE.Color(0x330000) });
        }

        // 破片 x 30
        const colors = [0xFF4400, 0xFF8800, 0xFFCC00, 0x555555, 0x222222];
        for (let i = 0; i < 30; i++) {
            const sz = 0.12 + Math.random() * 0.3;
            const geo = new THREE.BoxGeometry(sz, sz * 0.5, sz);
            const mat = new THREE.MeshBasicMaterial({ color: colors[Math.floor(Math.random() * colors.length)], transparent: true, opacity: 1.0 });
            const piece = new THREE.Mesh(geo, mat);
            this.group.add(piece);
            const angle = Math.random() * Math.PI * 2;
            const upAngle = Math.random() * Math.PI * 0.5;
            const speed = 7 + Math.random() * 16;
            this.particles.push({ mesh: piece, vx: Math.cos(angle) * Math.sin(upAngle) * speed, vy: Math.cos(upAngle) * speed + 5, vz: Math.sin(angle) * Math.sin(upAngle) * speed, rotSpeed: (Math.random() - 0.5) * 28 });
        }

        // 煙柱 x 8
        for (let i = 0; i < 8; i++) {
            const smokeGeo = new THREE.SphereGeometry(0.8 + Math.random() * 0.8, 6, 4);
            const smokeMat = new THREE.MeshBasicMaterial({ color: i < 4 ? 0x333333 : 0x111111, transparent: true, opacity: 0.65 });
            const smoke = new THREE.Mesh(smokeGeo, smokeMat);
            this.group.add(smoke);
            this.particles.push({ mesh: smoke, vx: (Math.random() - 0.5) * 3, vy: 2.5 + Math.random() * 4, vz: (Math.random() - 0.5) * 3, scale: 5.0, fadeDelay: 0.15, noGravity: true });
        }

        // 二重衝撃波
        this._addShockwave();
        this._addGroundScorch(3.5);

        const light = new THREE.PointLight(0xFF6600, 10, 35);
        this.group.add(light);
        this.flashLight = light;
    }

    // ============================================
    // 衝撃波リング
    // ============================================
    _addShockwave() {
        const shockwaveGeo = new THREE.RingGeometry(0.1, 0.5, 32);
        const shockwaveMat = new THREE.MeshBasicMaterial({
            color: 0xFFDD88,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
        });
        const shockwave = new THREE.Mesh(shockwaveGeo, shockwaveMat);
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
        const scorchGeo = new THREE.CircleGeometry(radius, 16);
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
            fadeTimer: 8.0, // 8秒後にフェードアウト
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

            // スケール拡大
            if (p.scale) {
                const s = 1 + (p.scale - 1) * progress;
                p.mesh.scale.setScalar(s);
            }

            // カラーフェード
            if (p.colorFade && p.startColor && p.endColor) {
                const c = p.startColor.clone().lerp(p.endColor, progress);
                p.mesh.material.color.copy(c);
            }

            // フェードアウト
            const fadeStart = p.fadeDelay || 0;
            const fadeProgress = Math.max(0, (progress - fadeStart) / (1 - fadeStart));
            if (p.mesh.material.transparent) {
                p.mesh.material.opacity = Math.max(0, 1 - fadeProgress);
            }

            // エンバー: ランダムな明滅
            if (p.isEmber) {
                p.mesh.material.opacity = Math.max(0, (1 - progress) * (0.5 + Math.random() * 0.5));
            }
        });

        // 衝撃波更新
        this.extras.forEach(e => {
            if (e.type === 'shockwave') {
                const s = 1 + e.expandSpeed * this.age;
                if (s < e.maxScale) {
                    e.mesh.scale.setScalar(s);
                    e.mesh.material.opacity = Math.max(0, 0.7 * (1 - s / e.maxScale));
                } else {
                    e.mesh.visible = false;
                }
            }
        });

        // ライトの減衰
        if (this.flashLight) {
            this.flashLight.intensity *= (1 - dt * 6);
            if (this.flashLight.intensity < 0.05) {
                this.group.remove(this.flashLight);
                this.flashLight.dispose();
                this.flashLight = null;
            }
        }
    }

    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(child => {
            if (child.isMesh) {
                // 共有ジオメトリは破棄しない
                if (!Object.values(_geoCache).includes(child.geometry)) {
                    child.geometry.dispose();
                }
                child.material.dispose();
            }
            if (child.isLight && child.dispose) {
                child.dispose();
            }
        });

        // 焦げ跡のクリーンアップ: 確実に削除される安全なパターン
        this.extras.forEach(e => {
            if (e.type === 'scorch') {
                const scorch = e.mesh;
                const scene = e.scene;
                // 最大15秒後に確実に削除（メモリリーク防止）
                const delay = Math.min((e.fadeTimer || 5) * 1000, 15000);
                setTimeout(() => {
                    if (scorch.parent) scene.remove(scorch);
                    if (scorch.geometry && !Object.values(_geoCache).includes(scorch.geometry)) {
                        scorch.geometry.dispose();
                    }
                    if (scorch.material) scorch.material.dispose();
                }, delay);
            }
        });
    }
}
