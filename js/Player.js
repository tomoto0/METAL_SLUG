import * as THREE from 'three';
import { Projectile } from './Projectile.js';
import { Explosion } from './Explosion.js';

/**
 * SV-001 "Metal Slug" 風プレイヤー戦車
 * 縦スクロール 3D 版: +Z 方向に自動スクロール、プレイヤーは +X 左右・+Z 前後に移動
 */
export class Player {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.speed = 12;
        this.hp = 100;
        this.maxHp = 100;

        // 加速/減速（スムーズな動き）
        this.velocityX = 0;
        this.velocityZ = 0;
        this.acceleration = 60;  // 加速度
        this.deceleration = 40;  // 減速度（摩擦）

        this.group = new THREE.Group();
        // visualGroup は「モデルのローカル +X = ワールド +Z (前方)」となる baseline 回転を担う。
        // 全パーツはこの中に入れる。tilt 等のアニメーションもここに当てる。
        this.visualGroup = new THREE.Group();
        this.visualGroup.rotation.y = -Math.PI / 2;
        this.group.add(this.visualGroup);

        this.buildSV001();
        this.group.position.set(0, 0, 0);
        this.scene.add(this.group);

        // 自動スクロール位置（main.jsから設定される）
        this.scrollZ = 0;

        // 射撃（Metal Slug 原作準拠のチューニング）
        // - バルカン: 連射 0.13s (約 7.7 shots/sec)、1発 10 dmg → 77 DPS
        // - キャノン: 発射間隔 1.0s (原作は3発×0.3s程度のラッシュ発射だが、ここはチャージ式)
        this.fireRate = 0.13;
        this.lastFireTime = 0;
        this.cannonFireRate = 1.0;
        this.lastCannonTime = 0;
        this.projectiles = [];
        this.effects = [];

        // 照準用 Raycaster（地面 Y=0 平面に対してレイキャスト）
        this.raycaster = new THREE.Raycaster();
        this.aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // Y=0 の地面
        this.aimPoint = new THREE.Vector3();

        // 砲塔のワールドヨー（0 = +Z 方向、正 = +X 右）とピッチ（仰角、負で下向き）
        this.turretYaw = 0;
        this.turretPitch = -0.25;
        // キーボード照準モード用の内部的な yaw / pitch（ワールド空間）
        this.keyboardYaw = 0;
        this.keyboardPitch = -0.25;
        this.aimAngleDeg = 0; // UI 表示用（仰角度数）
        this.aimMode = 'mouse'; // 'mouse' or 'keyboard'
        this.keyboardAimYawSpeed = Math.PI * 2.0;   // キーボード照準のヨー速度（rad/s）
        this.keyboardAimPitchSpeed = Math.PI * 1.4; // 〃 ピッチ速度

        // UI 向き判定用: 砲塔が前方半球にあるか（True = 前方、False = 後方）
        this.facingRight = true;

        // 被弾・無敵
        this.invincibleTimer = 0;
        this.invincibleDuration = 0.8;
        this.dead = false;
        this.flashTimer = 0;
        this._originalMaterials = [];

        // アニメーション用
        this.moveDir = 0;
        this.bodyTilt = 0;
        this.exhaustTimer = 0;
        this.vulcanRecoil = 0;
        this.barrelRecoil = 0;

        // 視覚エフェクト
        this.dustParticles = [];
        this.exhaustParticles = [];
        this.shellCasings = [];
        this.dustTimer = 0;
        this.exhaustPuffTimer = 0;

        // ヘッドライト
        this.headlight = new THREE.PointLight(0xAADD55, 0.5, 8);
        this.headlight.position.set(1.3, 1.15, 0);
        this.visualGroup.add(this.headlight);

        // 手榴弾（原作: 10発スタート、ARMS BOMB 表示）
        this.grenadeCount = 10;
        this.maxGrenades = 99;
        this.grenadeCooldown = 0;
        this.grenadeRate = 0.5;

        // 特殊武器 (Feature 2)
        this.specialWeapon = null;  // null | 'H' | 'R' | 'F' | 'S'
        this.specialAmmo = 0;
        this.baseFireRate = 0.13;

        // 手榴弾軌跡プレビュー (Feature 6)
        this.grenadeTrajectory = this._makeTrajectoryLine();

        // ダッシュ
        this.dashCooldown = 0;
        this.dashDuration = 0;
        this.dashSpeed = 35;
        this.dashCooldownMax = 1.5;
        this.dashDurationMax = 0.2;
        this.dashDir = new THREE.Vector3();
        this.dashAfterImages = [];

        // キャノンチャージ
        this.cannonCharging = false;
        this.cannonCharge = 0;
        this.cannonChargeMax = 1.5;

        // 縦スクロール用: プレイヤーのローカルオフセット
        // localOffsetZ = 前後（スクロール位置基準、+前進 / -後退）
        // localOffsetX = 左右（横方向の移動）
        this.localOffsetX = 0;
        this.localOffsetZ = 0;
        this.displayOffsetX = 0; // カメラ横追従ダンプ用

        // ジャンプ・しゃがみ用
        this.velocityY = 0;
        this.isJumping = false;
        this.gravity = 40;
        this.jumpForce = 15;
        this.isCrouching = false;
    }

    takeDamage(amount) {
        if (this.dead || this.invincibleTimer > 0) return;
        this.hp -= amount;
        if (this.hp < 0) this.hp = 0;
        this.invincibleTimer = this.invincibleDuration;
        this.flashTimer = 0.15;
        this._setFlashColor(0xFF2222);
        if (this.hp <= 0) {
            this.dead = true;
        }
    }

    isInvincible() {
        return this.invincibleTimer > 0 || this.dead;
    }

    _setFlashColor(color) {
        if (this._originalMaterials.length === 0) {
            this.group.traverse(child => {
                if (child.isMesh && child.material && child.material.color) {
                    this._originalMaterials.push({
                        mesh: child, color: child.material.color.getHex(),
                    });
                }
            });
        }
        this.group.traverse(child => {
            if (child.isMesh && child.material && child.material.color) {
                child.material.color.setHex(color);
            }
        });
    }

    _restoreColors() {
        this._originalMaterials.forEach(entry => {
            entry.mesh.material.color.setHex(entry.color);
        });
    }

    restart() {
        this.hp = this.maxHp;
        this.dead = false;
        this.invincibleTimer = 0;
        this.localOffsetX = 0;
        this.localOffsetZ = 0;
        this.velocityX = 0;
        this.velocityZ = 0;
        this.scrollZ = 0;
        this.group.position.set(0, 0, 0);
        this.group.visible = true;
        this._restoreColors();
        this.facingRight = true;
        this.turretYaw = 0;
        this.turretPitch = -0.25;
        this.keyboardYaw = 0;
        this.keyboardPitch = -0.25;
        this.aimAngleDeg = 0;
        this.aimMode = 'mouse';
        this.velocityY = 0;
        this.isJumping = false;
        this.isCrouching = false;
        this.grenadeCount = this.maxGrenades;
        this.grenadeCooldown = 0;
        this.specialWeapon = null;
        this.specialAmmo = 0;
        this.fireRate = this.baseFireRate;
        this._clearSpecialWeaponGlow();
        this._damageSmokeTimer = 0;
        this._prevHpRatio = 1.0;
        if (this.grenadeTrajectory) this.grenadeTrajectory.visible = false;
        this.dashCooldown = 0;
        this.dashDuration = 0;
        this.cannonCharging = false;
        this.cannonCharge = 0;
        this.lastFireTime = 0;
        this.lastCannonTime = 0;
        this.bodyTilt = 0;
        this.group.rotation.set(0, 0, 0);
        if (this.visualGroup) {
            this.visualGroup.rotation.set(0, -Math.PI / 2, 0);
        }
        if (this.turretGroup) this.turretGroup.rotation.y = 0;
        this.displayOffsetX = 0;
        if (this.hullGroup) this.hullGroup.position.y = 0;
        if (this.barrelGroup) this.barrelGroup.rotation.z = 0;
        if (this.cannonGroup) this.cannonGroup.position.x = 0;
        if (this.vulcanGroup) this.vulcanGroup.position.x = 0;

        this.projectiles.forEach(p => p.destroy());
        this.projectiles = [];
        this.effects.forEach(e => e.destroy());
        this.effects = [];

        this.dustParticles.forEach(p => {
            this.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        });
        this.dustParticles = [];
        this.exhaustParticles.forEach(p => {
            this.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        });
        this.exhaustParticles = [];
        this.shellCasings.forEach(p => {
            this.scene.remove(p.mesh);
            p.mesh.geometry.dispose();
            p.mesh.material.dispose();
        });
        this.shellCasings = [];
        this.dashAfterImages.forEach(img => {
            this.scene.remove(img.mesh);
            img.mesh.geometry.dispose();
            img.mesh.material.dispose();
        });
        this.dashAfterImages = [];
    }

    /**
     * SV-001風戦車の構築（元のコードを維持）
     */
    buildSV001() {
        // ============================================
        // SV-001 Metal Slug - 09_sv001_pixel_sprite.jpg 忠実再現
        // 特徴: 巨大球体砲塔、ずんぐりボディ、二連砲身、
        //       大型キャタピラ、ペリスコープ球、アンテナ
        // ============================================
        const C = {
            body:     0x8E9070,  // Metal Slug風 明るいオリーブグレー
            bodyHi:   0xBBBDA0,  // 明るいハイライト
            bodyDk:   0x5A5D48,  // シャドウ
            bodyMid:  0x7E8068,  // 中間トーン
            track:    0x383828,  // キャタピラ（ダークオリーブ）
            trackIn:  0x4A4A38,  // キャタピラ内側
            wheel:    0x3E3E3E,  // ホイール
            wheelHub: 0x606058,  // ハブ
            metal:    0x606060,  // 砲身メタル
            metalDk:  0x404040,  // ダークメタル
            outline:  0x252518,  // アウトライン
            light:    0xE0A020,  // ヘッドライト（アンバー）
            exhaust:  0x6A6A62,  // 排気管
            hatch:    0x6E8060,  // ハッチ
            flag:     0xDD2222,  // 旗（より鮮やかな赤）
        };

        this.hullGroup = new THREE.Group();
        this.visualGroup.add(this.hullGroup);

        // ============================================
        // 1. キャタピラ（左右） - 画像: 非常に大きく厚い
        //    前後に大きな起動輪/誘導輪、中間に転輪3つ
        // ============================================
        this.wheels = [];
        const trackH = 1.3;  // キャタピラ高さ（大きめ）
        const trackW = 3.2;  // キャタピラ幅
        const trackD = 0.55; // キャタピラ厚み

        for (let side = -1; side <= 1; side += 2) {
            const tg = new THREE.Group();

            // キャタピラ外殻 - 丸みのある厚い帯
            const outerGeo = this._roundedBox(trackW, trackH, trackD, 0.25, C.track);
            outerGeo.position.set(0, trackH / 2, 0);
            tg.add(outerGeo);

            // キャタピラ内側ディテール
            const innerGeo = this._roundedBox(trackW - 0.4, trackH - 0.3, trackD - 0.15, 0.2, C.trackIn);
            innerGeo.position.set(0, trackH / 2, 0);
            tg.add(innerGeo);

            // 前方起動輪（大きい）
            const bigWheelMat = new THREE.MeshStandardMaterial({ color: C.wheel, roughness: 0.4, metalness: 0.5 });
            const frontWheelGeo = new THREE.CylinderGeometry(0.48, 0.48, 0.18, 16);
            const frontWheel = new THREE.Mesh(frontWheelGeo, bigWheelMat);
            frontWheel.rotation.x = Math.PI / 2;
            frontWheel.position.set(1.2, trackH * 0.5, side * 0.08);
            tg.add(frontWheel);
            this.wheels.push(frontWheel);
            // フロントハブ
            const fhub = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.18, 0.22, 8),
                new THREE.MeshStandardMaterial({ color: C.wheelHub, metalness: 0.6, roughness: 0.3 })
            );
            fhub.rotation.x = Math.PI / 2;
            fhub.position.copy(frontWheel.position);
            fhub.position.z += side * 0.05;
            tg.add(fhub);

            // 後方誘導輪（大きい）
            const rearWheel = new THREE.Mesh(frontWheelGeo, bigWheelMat);
            rearWheel.rotation.x = Math.PI / 2;
            rearWheel.position.set(-1.2, trackH * 0.5, side * 0.08);
            tg.add(rearWheel);
            this.wheels.push(rearWheel);
            const rhub = fhub.clone();
            rhub.position.copy(rearWheel.position);
            rhub.position.z += side * 0.05;
            tg.add(rhub);

            // 中間転輪（3つ、やや小さめ）
            const midWheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.15, 12);
            for (const mx of [-0.5, 0.15, 0.8]) {
                const mw = new THREE.Mesh(midWheelGeo, bigWheelMat);
                mw.rotation.x = Math.PI / 2;
                mw.position.set(mx, trackH * 0.38, side * 0.06);
                tg.add(mw);
                this.wheels.push(mw);
                // 小ハブ
                const mhub = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.1, 0.1, 0.18, 6),
                    new THREE.MeshStandardMaterial({ color: C.wheelHub, metalness: 0.5 })
                );
                mhub.rotation.x = Math.PI / 2;
                mhub.position.copy(mw.position);
                mhub.position.z += side * 0.04;
                tg.add(mhub);
            }

            // 上部フェンダー（泥除け）
            const fender = new THREE.Mesh(
                new THREE.BoxGeometry(trackW - 0.2, 0.07, trackD + 0.05),
                new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.7, metalness: 0.15 })
            );
            fender.position.set(0, trackH + 0.03, 0);
            tg.add(fender);

            tg.position.set(0, 0, side * 0.85);
            this.visualGroup.add(tg);
        }

        // ============================================
        // 2. 車体 - 画像: 膨らんだずんぐりボディ
        //    上下2段構成、前面は丸い装甲
        // ============================================
        // 下部車体（膨らんだ腹）
        const hullBelly = new THREE.Mesh(
            new THREE.SphereGeometry(1.3, 18, 14, 0, Math.PI * 2, Math.PI * 0.25, Math.PI * 0.45),
            new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.55, metalness: 0.15 })
        );
        hullBelly.scale.set(1.15, 0.65, 0.7);
        hullBelly.position.set(0, 1.25, 0);
        hullBelly.castShadow = true;
        this.hullGroup.add(hullBelly);

        // 上部車体（丸みのある箱）
        const hullTop = this._roundedBox(2.4, 0.7, 1.5, 0.2, C.body);
        hullTop.position.set(0, 1.6, 0);
        hullTop.castShadow = true;
        this.hullGroup.add(hullTop);

        // 車体ハイライト帯（画像の白い光沢）
        const hullHighlight = new THREE.Mesh(
            new THREE.SphereGeometry(1.1, 16, 10, Math.PI * 0.2, Math.PI * 0.5, Math.PI * 0.15, Math.PI * 0.25),
            new THREE.MeshStandardMaterial({ color: C.bodyHi, roughness: 0.3, metalness: 0.1 })
        );
        hullHighlight.scale.set(1.1, 0.5, 0.65);
        hullHighlight.position.set(0.2, 1.7, 0);
        this.hullGroup.add(hullHighlight);

        // 前面装甲（丸い膨らみ）
        const frontPlate = new THREE.Mesh(
            new THREE.SphereGeometry(0.6, 14, 10, 0, Math.PI, 0, Math.PI * 0.5),
            new THREE.MeshStandardMaterial({ color: C.bodyMid, roughness: 0.5, metalness: 0.2 })
        );
        frontPlate.scale.set(0.5, 0.9, 1.4);
        frontPlate.position.set(1.3, 1.35, 0);
        frontPlate.rotation.z = -0.25;
        this.hullGroup.add(frontPlate);

        // 後部エンジンデッキ
        const rearDeck = this._roundedBox(0.7, 0.5, 1.3, 0.1, C.bodyDk);
        rearDeck.position.set(-1.05, 1.35, 0);
        this.hullGroup.add(rearDeck);

        // 排気管（後部、2本）
        const exhMat = new THREE.MeshStandardMaterial({ color: C.exhaust, roughness: 0.4, metalness: 0.5 });
        for (const sz of [0.35, -0.35]) {
            const exh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.55, 8), exhMat);
            exh.position.set(-1.2, 1.65, sz);
            exh.rotation.z = 0.2;
            this.hullGroup.add(exh);
        }

        // サイドスカート（装甲板）
        for (const s of [-1, 1]) {
            const skirt = new THREE.Mesh(
                new THREE.BoxGeometry(2.2, 0.2, 0.06),
                new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.65 })
            );
            skirt.position.set(0, 1.2, s * 0.72);
            this.hullGroup.add(skirt);
        }

        // リベット（車体側面に2列）
        const rivGeo = new THREE.SphereGeometry(0.028, 4, 4);
        const rivMat = new THREE.MeshStandardMaterial({ color: C.metalDk, metalness: 0.6 });
        for (let x = -0.8; x <= 1.0; x += 0.3) {
            for (const s of [-1, 1]) {
                const r1 = new THREE.Mesh(rivGeo, rivMat);
                r1.position.set(x, 1.55, s * 0.76);
                this.hullGroup.add(r1);
                const r2 = new THREE.Mesh(rivGeo, rivMat);
                r2.position.set(x, 1.35, s * 0.76);
                this.hullGroup.add(r2);
            }
        }

        // ============================================
        // 3. 砲塔 - 画像: 巨大な球体ドーム（最大の特徴）
        //    ほぼ完全な球に近い、車体より大きいドーム
        // ============================================
        this.turretGroup = new THREE.Group();

        // メインドーム（巨大半球、画像の最も目立つ部分）
        const domeR = 1.05; // 大きめの半径
        const turretDome = new THREE.Mesh(
            new THREE.SphereGeometry(domeR, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.58),
            new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.45, metalness: 0.18 })
        );
        turretDome.castShadow = true;
        this.turretGroup.add(turretDome);

        // ドームハイライト（画像の白い光沢 - 左上に大きな反射）
        const domeHi1 = new THREE.Mesh(
            new THREE.SphereGeometry(domeR + 0.01, 20, 14, Math.PI * 0.15, Math.PI * 0.5, Math.PI * 0.05, Math.PI * 0.3),
            new THREE.MeshStandardMaterial({ color: C.bodyHi, roughness: 0.25, metalness: 0.08 })
        );
        this.turretGroup.add(domeHi1);

        // ドーム下部の影帯
        const domeShadow = new THREE.Mesh(
            new THREE.SphereGeometry(domeR + 0.01, 20, 14, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.15),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.6, metalness: 0.1 })
        );
        this.turretGroup.add(domeShadow);

        // 砲塔ベースリング（ターレットリング）
        const tRing = new THREE.Mesh(
            new THREE.TorusGeometry(domeR * 0.85, 0.07, 8, 24),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.3 })
        );
        tRing.rotation.x = Math.PI / 2;
        tRing.position.y = 0.02;
        this.turretGroup.add(tRing);

        // 砲塔後部の膨らみ（排気/マフラー的な突起）
        const turretRear = new THREE.Mesh(
            new THREE.SphereGeometry(0.35, 10, 8, 0, Math.PI, 0, Math.PI * 0.6),
            new THREE.MeshStandardMaterial({ color: C.bodyMid, roughness: 0.5, metalness: 0.2 })
        );
        turretRear.rotation.y = Math.PI;
        turretRear.position.set(-0.85, 0.15, 0);
        this.turretGroup.add(turretRear);

        // ============================================
        // 4. 二連砲身 - 画像: 上下2本の砲身がセグメント付きで突出
        // ============================================
        this.barrelGroup = new THREE.Group();
        this.cannonGroup = new THREE.Group();
        this.vulcanGroup = new THREE.Group();
        const bMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.7 });
        const bDkMat = new THREE.MeshStandardMaterial({ color: C.metalDk, roughness: 0.25, metalness: 0.8 });

        // 上砲身（メインキャノン）
        const upperBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.13, 2.0, 10),
            bMat
        );
        upperBarrel.rotation.z = -Math.PI / 2;
        upperBarrel.position.set(1.0, 0.12, 0);
        this.cannonGroup.add(upperBarrel);

        // 下砲身（バルカン砲）
        const lowerBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.1, 2.2, 10),
            bMat
        );
        lowerBarrel.rotation.z = -Math.PI / 2;
        lowerBarrel.position.set(1.1, -0.12, 0);
        this.vulcanGroup.add(lowerBarrel);

        // 砲身セグメントリング（画像の節々）
        for (const rx of [0.3, 0.7, 1.1, 1.5]) {
            const upperSeg = new THREE.Mesh(
                new THREE.TorusGeometry(0.13, 0.018, 6, 10),
                bDkMat
            );
            upperSeg.rotation.y = Math.PI / 2;
            upperSeg.position.set(rx, 0.12, 0);
            this.cannonGroup.add(upperSeg);

            const lowerSeg = new THREE.Mesh(
                new THREE.TorusGeometry(0.1, 0.018, 6, 10),
                bDkMat
            );
            lowerSeg.rotation.y = Math.PI / 2;
            lowerSeg.position.set(rx, -0.12, 0);
            this.vulcanGroup.add(lowerSeg);
        }

        // マズルブレーキ（上砲身先端 - やや太い）
        const muzzleUp = new THREE.Mesh(
            new THREE.CylinderGeometry(0.17, 0.12, 0.22, 10),
            bDkMat
        );
        muzzleUp.rotation.z = -Math.PI / 2;
        muzzleUp.position.set(2.0, 0.12, 0);
        this.cannonGroup.add(muzzleUp);

        // マズル（下砲身先端）
        const muzzleLo = new THREE.Mesh(
            new THREE.CylinderGeometry(0.13, 0.09, 0.18, 10),
            bDkMat
        );
        muzzleLo.rotation.z = -Math.PI / 2;
        muzzleLo.position.set(2.15, -0.12, 0);
        this.vulcanGroup.add(muzzleLo);

        this.cannonMuzzleAnchor = new THREE.Object3D();
        this.cannonMuzzleAnchor.position.set(2.12, 0.12, 0);
        this.cannonGroup.add(this.cannonMuzzleAnchor);

        this.vulcanMuzzleAnchor = new THREE.Object3D();
        this.vulcanMuzzleAnchor.position.set(2.25, -0.12, 0);
        this.vulcanGroup.add(this.vulcanMuzzleAnchor);

        // 砲身基部カバー（砲塔との接続部）
        const barrelBase = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 10, 8),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.25 })
        );
        barrelBase.scale.set(0.8, 1.0, 1.0);
        barrelBase.position.set(0, 0, 0);
        this.barrelGroup.add(barrelBase);
        this.barrelGroup.add(this.cannonGroup);
        this.barrelGroup.add(this.vulcanGroup);

        this.barrelGroup.position.set(0.55, 0.1, 0);
        this.turretGroup.add(this.barrelGroup);

        // ============================================
        // 5. ペリスコープ - 画像: 砲塔頂部の丸い球体突起
        // ============================================
        const periBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.1, 0.2, 8),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.3 })
        );
        periBase.position.set(0.1, domeR * 0.52, 0);
        this.turretGroup.add(periBase);

        const periSphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 10, 8),
            new THREE.MeshStandardMaterial({ color: C.bodyMid, roughness: 0.35, metalness: 0.3 })
        );
        periSphere.position.set(0.1, domeR * 0.52 + 0.18, 0);
        this.turretGroup.add(periSphere);

        // ============================================
        // 6. アンテナ - 画像: 砲塔後方の短い棒
        // ============================================
        const ant = new THREE.Mesh(
            new THREE.CylinderGeometry(0.012, 0.018, 0.7, 4),
            new THREE.MeshStandardMaterial({ color: C.metal })
        );
        ant.position.set(-0.4, domeR * 0.45, 0.25);
        ant.rotation.z = 0.2;
        this.turretGroup.add(ant);

        // 砲塔を車体の上に配置
        this.turretGroup.position.set(-0.05, 2.05, 0);
        this.hullGroup.add(this.turretGroup);

        // ============================================
        // 7. パイロットハッチ（砲塔後方）
        // ============================================
        const hatch = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.26, 0.07, 12),
            new THREE.MeshStandardMaterial({ color: C.hatch, roughness: 0.5, metalness: 0.3 })
        );
        hatch.position.set(-0.45, 2.4, 0);
        this.hullGroup.add(hatch);

        // ============================================
        // 8. 旗（後部アンテナ先端）
        // ============================================
        const flagPole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.01, 0.013, 0.9, 4),
            new THREE.MeshStandardMaterial({ color: C.metal })
        );
        flagPole.position.set(-0.9, 2.7, 0.3);
        flagPole.rotation.z = 0.12;
        this.hullGroup.add(flagPole);

        this.flag = new THREE.Mesh(
            new THREE.PlaneGeometry(0.32, 0.2),
            new THREE.MeshStandardMaterial({ color: C.flag, side: THREE.DoubleSide, roughness: 0.8 })
        );
        this.flag.position.set(-0.9, 3.05, 0.3);
        this.hullGroup.add(this.flag);

        // ============================================
        // 9. ヘッドライト - 画像: 車体前面の小さなオレンジ点
        // ============================================
        const hlMat = new THREE.MeshStandardMaterial({
            color: C.light, emissive: C.light, emissiveIntensity: 0.7
        });
        const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), hlMat);
        hl.position.set(1.4, 1.25, 0.35);
        this.hullGroup.add(hl);
        const hl2 = hl.clone();
        hl2.position.set(1.4, 1.25, -0.35);
        this.hullGroup.add(hl2);

        // ============================================
        // 10. 追加ディテール（コンセプト画像寄せ）
        // ============================================
        // 履帯の駆動歯（シルエット強化）
        const toothMat = new THREE.MeshStandardMaterial({ color: 0x2A2A20, roughness: 0.85, metalness: 0.15 });
        for (const side of [-1, 1]) {
            for (let tx = -1.35; tx <= 1.35; tx += 0.24) {
                const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.07), toothMat);
                tooth.position.set(tx, 0.12, side * 0.94);
                this.visualGroup.add(tooth);
            }
        }

        // 側面パネルの溶接ライン
        const seamMat = new THREE.MeshStandardMaterial({ color: C.outline, roughness: 0.85, metalness: 0.1 });
        for (const side of [-1, 1]) {
            const seamTop = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.03, 0.03), seamMat);
            seamTop.position.set(0, 1.9, side * 0.73);
            this.hullGroup.add(seamTop);
            const seamBottom = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.03, 0.03), seamMat);
            seamBottom.position.set(0, 1.05, side * 0.73);
            this.hullGroup.add(seamBottom);
        }

        // 砲塔ボルトリング
        const boltMat = new THREE.MeshStandardMaterial({ color: C.metalDk, roughness: 0.35, metalness: 0.65 });
        for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2;
            const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 6), boltMat);
            bolt.position.set(Math.cos(a) * 0.9, 0.04, Math.sin(a) * 0.9);
            bolt.rotation.x = Math.PI / 2;
            this.turretGroup.add(bolt);
        }

        // 予備履帯ブロック（車体横）
        const spareTrackMat = new THREE.MeshStandardMaterial({ color: C.trackIn, roughness: 0.82, metalness: 0.2 });
        for (const side of [-1, 1]) {
            for (let i = 0; i < 4; i++) {
                const block = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.16, 0.1), spareTrackMat);
                block.position.set(-0.45 + i * 0.26, 1.42, side * 0.79);
                this.hullGroup.add(block);
            }
        }

        // 車載ツール（シャベル + 燃料缶）
        const toolMetal = new THREE.MeshStandardMaterial({ color: 0x555550, roughness: 0.45, metalness: 0.5 });
        const toolWood = new THREE.MeshStandardMaterial({ color: 0x7A5A34, roughness: 0.85, metalness: 0.0 });
        const shovelHandle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6), toolWood);
        shovelHandle.position.set(-0.65, 1.85, -0.67);
        shovelHandle.rotation.z = 0.18;
        this.hullGroup.add(shovelHandle);
        const shovelHead = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.04), toolMetal);
        shovelHead.position.set(-0.23, 1.47, -0.67);
        shovelHead.rotation.z = 0.18;
        this.hullGroup.add(shovelHead);

        const canMat = new THREE.MeshStandardMaterial({ color: 0x4F6A46, roughness: 0.7, metalness: 0.18 });
        for (const z of [-0.42, -0.18]) {
            const can = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.16), canMat);
            can.position.set(-1.24, 1.64, z);
            this.hullGroup.add(can);
        }

        // マーキング（SV-001 ナンバー風）
        const decalMat = new THREE.MeshStandardMaterial({ color: 0xE3E0CC, roughness: 0.7, metalness: 0.0 });
        const idPlate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.03), decalMat);
        idPlate.position.set(0.95, 1.74, 0.69);
        this.hullGroup.add(idPlate);
        for (const z of [0.64, -0.64]) {
            const star = new THREE.Mesh(
                new THREE.CircleGeometry(0.08, 5),
                new THREE.MeshStandardMaterial({ color: 0xD8D2AA, roughness: 0.75, side: THREE.DoubleSide })
            );
            star.position.set(0.35, 1.45, z);
            star.rotation.y = Math.PI / 2;
            this.hullGroup.add(star);
        }
    }

    _roundedBox(w, h, d, r, color) {
        const hw = w / 2 - r;
        const shape = new THREE.Shape();
        shape.moveTo(-hw, -h / 2);
        shape.lineTo(hw, -h / 2);
        shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
        shape.lineTo(w / 2, h / 2 - r);
        shape.quadraticCurveTo(w / 2, h / 2, hw, h / 2);
        shape.lineTo(-hw, h / 2);
        shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
        shape.lineTo(-w / 2, -h / 2 + r);
        shape.quadraticCurveTo(-w / 2, -h / 2, -hw, -h / 2);

        const extrudeSettings = {
            depth: d, bevelEnabled: true,
            bevelThickness: r * 0.5, bevelSize: r * 0.3, bevelSegments: 3,
        };

        const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
        geo.center();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15 });
        return new THREE.Mesh(geo, mat);
    }

    // ============================================
    // メインアップデート（サイドスクロール版）
    // ============================================
    update(dt, input, elapsedTime) {
        if (this.dead) return;

        // 無敵タイマー & フラッシュ
        if (this.invincibleTimer > 0) {
            this.invincibleTimer -= dt;
            this.group.visible = Math.floor(this.invincibleTimer / 0.05) % 2 === 0;
            if (this.invincibleTimer <= 0) {
                this.group.visible = true;
                this.invincibleTimer = 0;
            }
        }
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            if (this.flashTimer <= 0) this._restoreColors();
        }

        // ============================================
        // 縦スクロール移動（+Z 前方 / -Z 後方 / ±X 横）
        // ============================================
        let moveX = 0;
        let moveZ = 0;
        if (input.moveLeft) moveX -= 1;
        if (input.moveRight) moveX += 1;
        if (input.moveForward) moveZ += 1;   // W で前進（+Z 方向に microadjust）
        if (input.moveBackward) moveZ -= 1;  // S で後退

        // ダッシュ処理
        if (this.dashDuration > 0) {
            this.dashDuration -= dt;
            this.localOffsetX += this.dashDir.x * this.dashSpeed * dt;
            this.localOffsetZ += this.dashDir.z * this.dashSpeed * dt;
            this._spawnDashAfterImage();
        } else {
            // 加速/減速によるスムーズ移動
            const targetVX = moveX * this.speed;
            const targetVZ = moveZ * this.speed;
            if (moveX !== 0) {
                this.velocityX += (targetVX - this.velocityX) * Math.min(1, this.acceleration * dt);
            } else {
                this.velocityX *= Math.max(0, 1 - this.deceleration * dt);
                if (Math.abs(this.velocityX) < 0.1) this.velocityX = 0;
            }
            if (moveZ !== 0) {
                this.velocityZ += (targetVZ - this.velocityZ) * Math.min(1, this.acceleration * dt);
            } else {
                this.velocityZ *= Math.max(0, 1 - this.deceleration * dt);
                if (Math.abs(this.velocityZ) < 0.1) this.velocityZ = 0;
            }
            this.localOffsetX += this.velocityX * dt;
            this.localOffsetZ += this.velocityZ * dt;
        }

        if (this.dashCooldown > 0) this.dashCooldown -= dt;

        // しゃがみ
        this.isCrouching = input.crouchHeld;

        // ジャンプ
        if (input.jumpPressed && !this.isJumping) {
            this.velocityY = this.jumpForce;
            this.isJumping = true;
        }

        if (this.isJumping || this.group.position.y > 0) {
            this.velocityY -= this.gravity * dt;
            this.group.position.y += this.velocityY * dt;
            
            if (this.group.position.y <= 0) {
                this.group.position.y = 0;
                this.isJumping = false;
                this.velocityY = 0;
            }
        }

        // しゃがみモーション (車体を下げる)
        const targetHullY = this.isCrouching ? -0.4 : 0;
        if (this.hullGroup) {
            this.hullGroup.position.y += (targetHullY - this.hullGroup.position.y) * 0.3;
        }

        if (input.dashPressed && this.dashCooldown <= 0 && this.dashDuration <= 0) {
            if (moveX !== 0 || moveZ !== 0) {
                this.dashDir.set(moveX, 0, moveZ).normalize();
                this.dashDuration = this.dashDurationMax;
                this.dashCooldown = this.dashCooldownMax;
                if (this.soundManager) this.soundManager.playVulcan();
            }
        }

        // 画面内制限
        // 横方向（±X）はやや広め
        this.localOffsetX = Math.max(-8, Math.min(8, this.localOffsetX));
        // 前後（±Z）: スクロール位置を基準に前 +15 後 -12 まで
        this.localOffsetZ = Math.max(-12, Math.min(15, this.localOffsetZ));

        // ワールド位置 = スクロール位置 + ローカルオフセット
        this.group.position.x = this.localOffsetX;
        this.group.position.z = this.scrollZ + this.localOffsetZ;
        this.displayOffsetX += (this.localOffsetX - this.displayOffsetX) * 0.18;

        // 車体の傾き演出（visualGroup に当てる — group 自体は傾けない）
        const targetTilt = (moveX !== 0) ? 0.03 * moveX : 0;
        this.bodyTilt += (targetTilt - this.bodyTilt) * 0.1;
        // 傾きはモデルのローカル +X (= world +Z 前方) を軸とする → visualGroup の rotation.x に相当
        this.visualGroup.rotation.x = this.bodyTilt;

        // 転輪回転（自動スクロール + 前後入力に連動）
        const moveSpeed = Math.sqrt(moveX * moveX + moveZ * moveZ);
        const wheelSpeed = (moveZ * 12) + 6; // 常にスクロール分も回す
        if (moveSpeed > 0 || wheelSpeed !== 0) {
            this.wheels.forEach(w => { w.rotation.y += wheelSpeed * dt; });
        }

        // 旗の揺れ
        if (this.flag) {
            this.flag.rotation.z = Math.sin(Date.now() * 0.005) * 0.15;
        }

        // 砲塔エイム（マウス or 矢印キーで照準操作）
        this._updateTurretAim(input, dt);

        // 射撃
        if (elapsedTime !== undefined && input.fireHeld && !this.cannonCharging) {
            this._fireVulcan(elapsedTime);
        }

        // キャノンチャージ（右クリック長押し / Fキー）
        if (input.altFireHeld) {
            if (!this.cannonCharging) {
                this.cannonCharging = true;
                this.cannonCharge = 0;
            }
            this.cannonCharge = Math.min(this.cannonCharge + dt, this.cannonChargeMax);
            if (this.barrelGroup) {
                const chargeRatio = this.cannonCharge / this.cannonChargeMax;
                this.barrelGroup.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive = child.material.emissive || new THREE.Color();
                        child.material.emissive.setHex(chargeRatio > 0.5 ? 0xFF6600 : 0x442200);
                        child.material.emissiveIntensity = chargeRatio * 0.5;
                    }
                });
            }
        } else if (this.cannonCharging) {
            this.cannonCharging = false;
            this._fireChargedCannon(elapsedTime);
            if (this.barrelGroup) {
                this.barrelGroup.traverse(child => {
                    if (child.isMesh && child.material && child.material.emissive) {
                        child.material.emissiveIntensity = 0;
                    }
                });
            }
        }

        // 手榴弾
        this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
        if (input.grenadePressed && this.grenadeCount > 0 && this.grenadeCooldown <= 0) {
            this._throwGrenade();
        }

        // リコイル回復
        this.vulcanRecoil *= 0.85;
        this.barrelRecoil *= 0.85;
        if (this.vulcanGroup) {
            this.vulcanGroup.position.x = -this.vulcanRecoil * 0.12;
        }
        if (this.cannonGroup) {
            this.cannonGroup.position.x = -this.barrelRecoil * 0.16;
        }

        // 走行時の砂埃
        if (moveSpeed > 0) {
            this.dustTimer += dt;
            if (this.dustTimer > 0.06) {
                this.dustTimer = 0;
                this._spawnTrackDust(moveX, moveZ);
            }
        }

        // 排気煙
        this.exhaustPuffTimer += dt;
        if (this.exhaustPuffTimer > (moveSpeed > 0 ? 0.15 : 0.5)) {
            this.exhaustPuffTimer = 0;
            this._spawnExhaustPuff();
        }

        // パーティクル更新
        this._updateParticleEffects(dt);
        this._updateDashAfterImages(dt);

        // 弾丸・エフェクト更新
        this.projectiles.forEach(p => p.update(dt));
        this.projectiles.forEach(p => {
            if (!p.alive && !p.impactPending && p.destroy) p.destroy();
        });
        this.projectiles = this.projectiles.filter(p => p.alive || p.impactPending);
        this.effects.forEach(e => e.update(dt));
        this.effects.forEach(e => {
            if (!e.alive && e.destroy) e.destroy();
        });
        this.effects = this.effects.filter(e => e.alive);

        // Feature 4: ダメージ視覚演出
        this._updateDamageVisuals(dt);

        // Feature 6: 手榴弾軌跡プレビュー
        this._updateGrenadePreview(input);
    }

    _updateTurretAim(input, dt) {
        // InputManagerのモード更新
        if (input.updateAimMode) input.updateAimMode(dt);

        // WASD キーボードエイムは廃止。常にマウス入力で砲塔を制御
        this.aimMode = 'mouse';

        const minElev = -40 * Math.PI / 180;  // 下向き
        const maxElev =  85 * Math.PI / 180;  // 上向き（対空射撃のためほぼ真上まで許可）

        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);

        // ============================================
        // 1) aimPoint（地面 Y=0 上のワールド座標）を決定
        // ============================================
        if (this.aimMode === 'keyboard') {
            // キーボードモード: ワールド空間の yaw / pitch を矢印キーで更新
            if (input.aimLeft)  this.keyboardYaw -= this.keyboardAimYawSpeed * dt;
            if (input.aimRight) this.keyboardYaw += this.keyboardAimYawSpeed * dt;
            if (input.aimUp)    this.keyboardPitch += this.keyboardAimPitchSpeed * dt;
            if (input.aimDown)  this.keyboardPitch -= this.keyboardAimPitchSpeed * dt;
            this.keyboardPitch = THREE.MathUtils.clamp(this.keyboardPitch, minElev, maxElev);

            // 擬似的な aimPoint を生成（砲塔前方 20m 先、地面に投影）
            const dist = 20;
            // 砲塔から yaw 方向に向かう水平ベクトル: (sin yaw, 0, cos yaw) （yaw=0 で +Z 前方）
            // pitch を加えて一旦 3D ターゲットを作り、地面に射影
            const tx = turretWorldPos.x + Math.sin(this.keyboardYaw) * Math.cos(this.keyboardPitch) * dist;
            const tz = turretWorldPos.z + Math.cos(this.keyboardYaw) * Math.cos(this.keyboardPitch) * dist;
            // 地面 Y=0 での投影
            this.aimPoint.set(tx, 0, tz);
        } else {
            // マウスモード: まず対空ロックオンを試し、なければ地面 Y=0 平面へのレイキャスト
            const mouseNDC = new THREE.Vector2(input.mouseX, input.mouseY);
            this.raycaster.setFromCamera(mouseNDC, this.camera);

            // --- 対空ロックオン ---
            // マウスレイが飛行中の敵（aircraft）の近くを通るなら、その敵位置を aimPoint として採用する。
            // これにより砲塔が上方向（真上のステルス/爆撃機まで）にも仰角を取れるようになる。
            let airHitPoint = null;
            let airHitScore = Infinity;
            const enemies = this.getEnemies ? this.getEnemies() : null;
            if (enemies && enemies.length > 0) {
                for (const e of enemies) {
                    if (!e || !e.alive || e.type !== 'aircraft' || !e.group) continue;
                    const pos = e.group.position;
                    const rayDist = this.raycaster.ray.distanceToPoint(pos);
                    // 機体サイズを考慮したロックオン半径（画面上でだいたいの近さ）
                    if (rayDist < 3.5 && rayDist < airHitScore) {
                        airHitScore = rayDist;
                        airHitPoint = pos;
                    }
                }
            }

            if (airHitPoint) {
                this.aimPoint.copy(airHitPoint);
                const dx0 = airHitPoint.x - turretWorldPos.x;
                const dz0 = airHitPoint.z - turretWorldPos.z;
                if (dx0 * dx0 + dz0 * dz0 > 0.0001) {
                    this.keyboardYaw = Math.atan2(dx0, dz0);
                }
            } else {
                const groundHit = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(this.aimPlane, groundHit)) {
                    this.aimPoint.copy(groundHit);
                    const dx0 = groundHit.x - turretWorldPos.x;
                    const dz0 = groundHit.z - turretWorldPos.z;
                    if (dx0 * dx0 + dz0 * dz0 > 0.0001) {
                        this.keyboardYaw = Math.atan2(dx0, dz0);
                    }
                }
            }
        }

        // ============================================
        // 2) 砲塔ヨー（360° 全方位）
        // ============================================
        const dx = this.aimPoint.x - turretWorldPos.x;
        const dz = this.aimPoint.z - turretWorldPos.z;
        // ワールド空間での希望ヨー（yaw=0 で +Z 方向、+X 側で正）
        const worldYaw = Math.atan2(dx, dz);
        this.turretYaw = worldYaw;

        // visualGroup.rotation.y = -π/2 なので砲身ワールド方向 = (sin(T), 0, cos(T))
        // T = worldYaw で目標方向に一致する（π/2 オフセット不要）
        const targetTurretLocalY = worldYaw;

        // 差分を最短経路で補間（高応答性: 0.75）
        let diff = targetTurretLocalY - this.turretGroup.rotation.y;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        // 小さい差分は即時適用、大きな差分は補間
        const lerpFactor = Math.abs(diff) < 0.05 ? 1.0 : 0.75;
        this.turretGroup.rotation.y += diff * lerpFactor;

        // 前方半球にあるか（UI 表示用）
        this.facingRight = Math.cos(worldYaw) >= 0;

        // ============================================
        // 3) 砲身仰角（ピッチ）
        // ============================================
        const horiz = Math.hypot(dx, dz);
        const vert = this.aimPoint.y - turretWorldPos.y;  // 通常は負
        let elevAngle = Math.atan2(vert, Math.max(0.01, horiz));
        elevAngle = THREE.MathUtils.clamp(elevAngle, minElev, maxElev);
        this.turretPitch = elevAngle;

        if (this.barrelGroup) {
            // barrelGroup.rotation.z はモデルローカル軸での仰角（正で上向き）
            // local +X が砲身先端方向なので、仰角 +上 は local rotation.z が負になる符号関係。
            // （cannonGroup 内の砲身は rotation.z = -π/2 で +X に寝かせてあるため、barrelGroup.rotation.z で pitch を与える）
            const pitchDiff = elevAngle - this.barrelGroup.rotation.z;
            const pitchLerp = Math.abs(pitchDiff) < 0.02 ? 1.0 : 0.65;
            this.barrelGroup.rotation.z += pitchDiff * pitchLerp;
        }

        // UI: 仰角（度数）
        this.aimAngleDeg = Math.round(THREE.MathUtils.radToDeg(elevAngle));
    }

    _fireVulcan(elapsedTime) {
        // 特殊武器の連射レート（原作準拠）
        // H(HEAVY MG): 2倍連射、R(ROCKET): 低レート高威力、F(FLAME): 連射短射程、S(SHOTGUN): 拡散低レート
        if (this.specialWeapon === 'H') this.fireRate = 0.065;
        else if (this.specialWeapon === 'R') this.fireRate = 0.35;
        else if (this.specialWeapon === 'F') this.fireRate = 0.10;
        else if (this.specialWeapon === 'S') this.fireRate = 0.40;
        else this.fireRate = this.baseFireRate;

        if (elapsedTime - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsedTime;

        if (this.specialWeapon) {
            this._fireSpecial(elapsedTime);
            return;
        }

        const muzzleWorldPos = new THREE.Vector3();
        if (this.vulcanMuzzleAnchor) {
            this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
        } else {
            this.vulcanGroup.getWorldPosition(muzzleWorldPos);
        }

        const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
        if (fireDir.lengthSq() < 0.01) return;
        fireDir.normalize();

        fireDir.x += (Math.random() - 0.5) * 0.025;
        fireDir.y += (Math.random() - 0.5) * 0.018;
        fireDir.z += (Math.random() - 0.5) * 0.025;
        fireDir.normalize();

        const bullet = new Projectile(this.scene, {
            position: muzzleWorldPos,
            direction: fireDir,
            speed: 50,
            damage: 10,
            owner: 'player',
            type: 'bullet',
            maxDistance: 100,
        });
        this.projectiles.push(bullet);

        const flash = new Explosion(this.scene, muzzleWorldPos, {
            type: 'muzzle', color: 0xFFAA00,
        });
        this.effects.push(flash);

        this.vulcanRecoil = 1.0;
        if (this.soundManager) this.soundManager.playVulcan();
        this._spawnShellCasing();
    }

    fireCannon(elapsedTime) {
        if (elapsedTime - this.lastCannonTime < this.cannonFireRate) return;
        this.lastCannonTime = elapsedTime;

        const muzzleWorldPos = new THREE.Vector3();
        if (this.cannonMuzzleAnchor) {
            this.cannonMuzzleAnchor.getWorldPosition(muzzleWorldPos);
        } else {
            this.barrelGroup.getWorldPosition(muzzleWorldPos);
        }

        const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
        fireDir.normalize();

        const shell = new Projectile(this.scene, {
            position: muzzleWorldPos,
            direction: fireDir,
            speed: 38, damage: 50,
            owner: 'player', type: 'cannon', maxDistance: 120,
            blastRadius: 4.0,
        });
        this.projectiles.push(shell);

        const flash = new Explosion(this.scene, muzzleWorldPos, {
            type: 'muzzle', color: 0xFF6600,
        });
        this.effects.push(flash);

        this.barrelRecoil = 1.0;
        if (this.soundManager) this.soundManager.playCannon();
    }

    _fireChargedCannon(elapsedTime) {
        if (elapsedTime - this.lastCannonTime < this.cannonFireRate) {
            this.cannonCharge = 0;
            return;
        }
        this.lastCannonTime = elapsedTime;
        const chargeRatio = Math.max(0.2, this.cannonCharge / this.cannonChargeMax);

        const muzzleWorldPos = new THREE.Vector3();
        if (this.cannonMuzzleAnchor) {
            this.cannonMuzzleAnchor.getWorldPosition(muzzleWorldPos);
        } else {
            this.barrelGroup.getWorldPosition(muzzleWorldPos);
        }

        const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
        fireDir.normalize();

        const damage = Math.floor(55 + chargeRatio * 145); // base 55 → max 200
        const shell = new Projectile(this.scene, {
            position: muzzleWorldPos,
            direction: fireDir,
            speed: 32 + chargeRatio * 12,
            damage: damage,
            owner: 'player',
            type: 'cannon',
            maxDistance: 120,
            hitRadius: 0.4 + chargeRatio * 0.2,
            blastRadius: 4.2 + chargeRatio * 2.8,
        });
        if (shell.group) {
            shell.group.scale.setScalar(1 + chargeRatio * 2);
        }
        this.projectiles.push(shell);

        const flash = new Explosion(this.scene, muzzleWorldPos, {
            type: 'muzzle', color: chargeRatio > 0.7 ? 0xFF2200 : 0xFF6600,
        });
        this.effects.push(flash);

        this.barrelRecoil = 1.0 + chargeRatio * 1.5;
        this.cannonCharge = 0;
        if (this.soundManager) this.soundManager.playCannon();
    }

    _throwGrenade() {
        this.grenadeCount--;
        this.grenadeCooldown = this.grenadeRate;

        const startPos = this.group.position.clone();
        startPos.y += 1.5;

        const throwDir = new THREE.Vector3().subVectors(this.aimPoint, startPos);
        throwDir.y = 0;
        const throwDist = throwDir.length();
        throwDir.normalize();

        const grenadeGroup = new THREE.Group();
        const bodyGeo = new THREE.SphereGeometry(0.15, 8, 6);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x3B5B2B, roughness: 0.6, metalness: 0.2,
        });
        grenadeGroup.add(new THREE.Mesh(bodyGeo, bodyMat));

        const handleGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.2, 6);
        const handle = new THREE.Mesh(handleGeo, new THREE.MeshStandardMaterial({ color: 0x8B7355 }));
        handle.position.y = 0.15;
        grenadeGroup.add(handle);

        grenadeGroup.position.copy(startPos);
        this.scene.add(grenadeGroup);

        const speed = Math.min(throwDist * 1.2, 25);
        const grenade = {
            mesh: grenadeGroup,
            previousPosition: startPos.clone(),
            velocity: new THREE.Vector3(throwDir.x * speed, 6 + throwDist * 0.15, throwDir.z * speed),
            age: 0,
            fuseTime: 1.0,
            alive: true,
            impactPending: false,
            impactPosition: startPos.clone(),
            damage: 80,
            hitRadius: 0.28,
            blastRadius: 6.0,
            explosionVisual: 'mega',
        };

        const self = this;
        grenade.update = function(dt) {
            if (!this.alive || this.impactPending) return;
            this.age += dt;
            this.previousPosition.copy(this.mesh.position);
            this.velocity.y -= 20 * dt;
            this.mesh.position.x += this.velocity.x * dt;
            this.mesh.position.y += this.velocity.y * dt;
            this.mesh.position.z += this.velocity.z * dt;
            this.mesh.rotation.x += dt * 8;
            this.mesh.rotation.z += dt * 5;
            if (this.mesh.position.y <= 0.15) {
                this.mesh.position.y = 0.15;
                this.velocity.y = Math.abs(this.velocity.y) * 0.3;
                this.velocity.x *= 0.6;
                this.velocity.z *= 0.6;
            }
            if (this.age >= this.fuseTime) {
                this.alive = false;
                this.impactPending = true;
                this.impactPosition.copy(this.mesh.position);
                self.scene.remove(this.mesh);
            }
        };
        grenade.destroy = function() {
            this.alive = false;
            this.impactPending = false;
            self.scene.remove(this.mesh);
            this.mesh.traverse?.(child => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    child.material.dispose();
                }
            });
        };
        grenade.getPosition = function() {
            return this.impactPending ? this.impactPosition.clone() : this.mesh.position.clone();
        };
        grenade.type = 'grenade';

        this.projectiles.push(grenade);
        if (this.soundManager) this.soundManager.playVulcan();
    }

    _spawnDashAfterImage() {
        const ghostGeo = new THREE.BoxGeometry(2.4, 1.2, 1.8);
        const ghostMat = new THREE.MeshBasicMaterial({
            color: 0x88BBFF, transparent: true, opacity: 0.4,
        });
        const ghost = new THREE.Mesh(ghostGeo, ghostMat);
        ghost.position.copy(this.group.position);
        ghost.position.y += 0.8;
        ghost.rotation.copy(this.group.rotation);
        this.scene.add(ghost);
        this.dashAfterImages.push({ mesh: ghost, age: 0, maxAge: 0.3 });
    }

    _updateDashAfterImages(dt) {
        for (let i = this.dashAfterImages.length - 1; i >= 0; i--) {
            const img = this.dashAfterImages[i];
            img.age += dt;
            img.mesh.material.opacity = 0.4 * (1 - img.age / img.maxAge);
            img.mesh.scale.setScalar(1 + (img.age / img.maxAge) * 0.5);
            if (img.age >= img.maxAge) {
                this.scene.remove(img.mesh);
                img.mesh.geometry.dispose();
                img.mesh.material.dispose();
                this.dashAfterImages.splice(i, 1);
            }
        }
    }

    _spawnTrackDust(moveX, moveZ) {
        // メモリ上限チェック（砂埃パーティクル上限 20）
        if (this.dustParticles.length >= 20) return;

        const pos = this.group.position;
        // キャタピラは ±X 両側（幅 ≈ 0.85）にある。粉塵は各トラック後方（-Z 側）から舞う。
        for (let sx of [-0.85, 0.85]) {
            const dustGeo = new THREE.SphereGeometry(0.15 + Math.random() * 0.15, 4, 3);
            const dustMat = new THREE.MeshBasicMaterial({
                color: 0xC8B088, transparent: true, opacity: 0.4,
            });
            const dust = new THREE.Mesh(dustGeo, dustMat);
            dust.position.set(
                pos.x + sx + (Math.random() - 0.5) * 0.3,
                0.15 + Math.random() * 0.3,
                pos.z - 1.2 + (Math.random() - 0.5) * 0.5
            );
            this.scene.add(dust);
            this.dustParticles.push({
                mesh: dust, age: 0, maxAge: 0.4 + Math.random() * 0.3,
                vy: 0.5 + Math.random() * 1.0,
                vx: (Math.random() - 0.5) * 1.5,
                vz: -2.0 - moveZ * 1.5 + (Math.random() - 0.5) * 1.0,
                scaleRate: 2.0,
            });
        }
    }

    _spawnExhaustPuff() {
        // メモリ上限チェック（排気煙パーティクル上限 14）
        if (this.exhaustParticles.length >= 14) return;

        const pos = this.group.position;
        // 排気管は車体後部（-Z 側）の ±X オフセット位置
        for (let sx of [-0.35, 0.35]) {
            const puffGeo = new THREE.SphereGeometry(0.08 + Math.random() * 0.06, 4, 3);
            const puffMat = new THREE.MeshBasicMaterial({
                color: Math.random() > 0.5 ? 0x555555 : 0x666666,
                transparent: true, opacity: 0.35,
            });
            const puff = new THREE.Mesh(puffGeo, puffMat);
            puff.position.set(
                pos.x + sx + (Math.random() - 0.5) * 0.2,
                1.5 + Math.random() * 0.2,
                pos.z - 1.15
            );
            this.scene.add(puff);
            this.exhaustParticles.push({
                mesh: puff, age: 0, maxAge: 0.6 + Math.random() * 0.4,
                vy: 0.8 + Math.random() * 0.5,
                vx: (Math.random() - 0.5) * 0.3,
                vz: -0.5 + (Math.random() - 0.5) * 0.3,
                scaleRate: 2.5,
            });
        }
    }

    _spawnShellCasing() {
        // メモリ上限チェック（薬莢パーティクル上限 15）
        if (this.shellCasings.length >= 15) {
            // 古いものを強制削除
            const old = this.shellCasings.shift();
            this.scene.remove(old.mesh);
            old.mesh.geometry.dispose();
            old.mesh.material.dispose();
        }

        const pos = this.group.position;
        const casingGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.08, 4);
        const casingMat = new THREE.MeshStandardMaterial({
            color: 0xDDBB44, metalness: 0.8, roughness: 0.2,
        });
        const casing = new THREE.Mesh(casingGeo, casingMat);
        // 砲塔の側面からイジェクト。砲塔ワールド位置 + ランダム横オフセット
        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);
        const sideSign = Math.random() > 0.5 ? 1 : -1;
        casing.position.set(
            turretWorldPos.x + sideSign * 0.3,
            turretWorldPos.y + 0.2,
            turretWorldPos.z - 0.2
        );
        this.scene.add(casing);
        this.shellCasings.push({
            mesh: casing, age: 0, maxAge: 0.8,
            vy: 2 + Math.random() * 2,
            vx: sideSign * (2 + Math.random() * 2),
            vz: (Math.random() - 0.5) * 1.5,
            rotSpeed: 15 + Math.random() * 10,
        });
    }

    _updateParticleEffects(dt) {
        this.dustParticles = this.dustParticles.filter(p => {
            p.age += dt;
            if (p.age >= p.maxAge) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                return false;
            }
            const progress = p.age / p.maxAge;
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.mesh.scale.setScalar(1 + progress * p.scaleRate);
            p.mesh.material.opacity = 0.4 * (1 - progress);
            return true;
        });

        this.exhaustParticles = this.exhaustParticles.filter(p => {
            p.age += dt;
            if (p.age >= p.maxAge) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                return false;
            }
            const progress = p.age / p.maxAge;
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.mesh.scale.setScalar(1 + progress * p.scaleRate);
            p.mesh.material.opacity = 0.35 * (1 - progress);
            return true;
        });

        this.shellCasings = this.shellCasings.filter(p => {
            p.age += dt;
            if (p.age >= p.maxAge) {
                this.scene.remove(p.mesh);
                p.mesh.geometry.dispose();
                p.mesh.material.dispose();
                return false;
            }
            p.mesh.position.x += p.vx * dt;
            p.mesh.position.y += p.vy * dt;
            p.mesh.position.z += p.vz * dt;
            p.vy -= 15 * dt;
            p.mesh.rotation.x += p.rotSpeed * dt;
            p.mesh.rotation.z += p.rotSpeed * 0.7 * dt;
            if (p.mesh.position.y < 0.05) {
                p.mesh.position.y = 0.05;
                p.vy = 0;
                p.vx *= 0.9;
                p.vz *= 0.9;
                p.rotSpeed *= 0.9;
            }
            return true;
        });
    }

    // ========================================
    // Feature 2: 特殊武器システム
    // ========================================
    equipSpecial(code, ammo) {
        this.specialWeapon = code;
        this.specialAmmo = ammo;
        const colorMap = { H: 0xFFCC33, R: 0xCC3333, F: 0xFF6611, S: 0x33CC99 };
        if (this.vulcanGroup && colorMap[code]) {
            this.vulcanGroup.traverse(c => {
                if (c.isMesh && c.material) {
                    if (!c.material.emissive) c.material.emissive = new THREE.Color();
                    c.material.emissive.setHex(colorMap[code]);
                    c.material.emissiveIntensity = 0.5;
                }
            });
        }
    }

    _clearSpecialWeaponGlow() {
        if (this.vulcanGroup) {
            this.vulcanGroup.traverse(c => {
                if (c.isMesh && c.material && c.material.emissive) {
                    c.material.emissiveIntensity = 0;
                }
            });
        }
    }

    _fireSpecial(elapsedTime) {
        switch (this.specialWeapon) {
            case 'H': {
                // HEAVY MACHINE GUN: 連射 2倍、1.8倍ダメージ
                const muzzleWorldPos = new THREE.Vector3();
                if (this.vulcanMuzzleAnchor) this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
                const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
                if (fireDir.lengthSq() < 0.01) return;
                fireDir.normalize();
                fireDir.x += (Math.random() - 0.5) * 0.02;
                fireDir.normalize();
                const bullet = new Projectile(this.scene, {
                    position: muzzleWorldPos, direction: fireDir,
                    speed: 58, damage: 18, owner: 'player', type: 'bullet', maxDistance: 100,
                });
                this.projectiles.push(bullet);
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0xFFDD00 });
                this.effects.push(flash);
                this.vulcanRecoil = 1.0;
                this._spawnShellCasing();
                break;
            }
            case 'R': {
                // ROCKET LAUNCHER: 爆風、高威力（原作通り数発でボス級も削れる）
                const muzzleWorldPos = new THREE.Vector3();
                if (this.vulcanMuzzleAnchor) this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
                const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
                if (fireDir.lengthSq() < 0.01) return;
                fireDir.normalize();
                const rocket = new Projectile(this.scene, {
                    position: muzzleWorldPos, direction: fireDir,
                    speed: 32, damage: 80, owner: 'player', type: 'cannon',
                    maxDistance: 120, blastRadius: 5.0,
                });
                this.projectiles.push(rocket);
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0xFF4400 });
                this.effects.push(flash);
                this.barrelRecoil = 1.5;
                this.specialAmmo--;
                if (this.specialAmmo <= 0) {
                    this.specialWeapon = null;
                    this.fireRate = this.baseFireRate;
                    this._clearSpecialWeaponGlow();
                }
                return;
            }
            case 'F': {
                // FLAME SHOT: 3 発拡散、短射程、1発あたりやや低いが発射数多い
                const muzzleWorldPos = new THREE.Vector3();
                if (this.vulcanMuzzleAnchor) this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
                const baseDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
                if (baseDir.lengthSq() < 0.01) return;
                baseDir.normalize();
                for (let i = 0; i < 3; i++) {
                    const d = baseDir.clone();
                    d.x += (Math.random() - 0.5) * 0.15;
                    d.y += (Math.random() - 0.5) * 0.1;
                    d.normalize();
                    const flame = new Projectile(this.scene, {
                        position: muzzleWorldPos.clone(), direction: d,
                        speed: 24, damage: 14, owner: 'player', type: 'bullet', maxDistance: 20,
                    });
                    this.projectiles.push(flame);
                }
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0xFF6600 });
                this.effects.push(flash);
                this.vulcanRecoil = 0.5;
                break;
            }
            case 'S': {
                // SHOTGUN: 5発拡散、全弾命中で大ダメージ (原作通り近距離特化)
                const muzzleWorldPos = new THREE.Vector3();
                if (this.vulcanMuzzleAnchor) this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
                const baseDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
                if (baseDir.lengthSq() < 0.01) return;
                baseDir.normalize();
                for (let i = -2; i <= 2; i++) {
                    const d = baseDir.clone();
                    d.x += i * 0.08;
                    d.normalize();
                    const pellet = new Projectile(this.scene, {
                        position: muzzleWorldPos.clone(), direction: d,
                        speed: 48, damage: 20, owner: 'player', type: 'bullet', maxDistance: 28,
                    });
                    this.projectiles.push(pellet);
                }
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0x99FFCC });
                this.effects.push(flash);
                this.vulcanRecoil = 1.2;
                this.specialAmmo--;
                if (this.specialAmmo <= 0) {
                    this.specialWeapon = null;
                    this.fireRate = this.baseFireRate;
                    this._clearSpecialWeaponGlow();
                }
                return;
            }
        }
        // H / F の弾数消費（R / S は上で return）
        if (this.specialWeapon) {
            this.specialAmmo--;
            if (this.specialAmmo <= 0) {
                this.specialWeapon = null;
                this.fireRate = this.baseFireRate;
                this._clearSpecialWeaponGlow();
            }
        }
    }

    // ========================================
    // Feature 4: 戦車ダメージ視覚演出
    // ========================================
    _updateDamageVisuals(dt) {
        const hpRatio = this.hp / this.maxHp;

        let smokeRate = 0;
        if (hpRatio < 0.70) smokeRate = 0.30;
        if (hpRatio < 0.40) smokeRate = 0.13;
        if (hpRatio < 0.15) smokeRate = 0.06;

        if (smokeRate > 0) {
            this._damageSmokeTimer = (this._damageSmokeTimer || 0) + dt;
            if (this._damageSmokeTimer > smokeRate) {
                this._damageSmokeTimer = 0;
                this._spawnDamageSmoke(hpRatio);
            }
        }

        // 瀕死時の赤発光パルス
        if (hpRatio < 0.15 && this.hullGroup) {
            const pulse = Math.abs(Math.sin(Date.now() * 0.008));
            this.hullGroup.traverse(c => {
                if (c.isMesh && c.material && !c._damageIgnore) {
                    if (!c.material.emissive) c.material.emissive = new THREE.Color();
                    c.material.emissive.setHex(0xFF2211);
                    c.material.emissiveIntensity = pulse * 0.4;
                }
            });
        } else if (hpRatio >= 0.15 && this.hullGroup && this._prevHpRatio < 0.15) {
            // 回復時に発光解除
            this.hullGroup.traverse(c => {
                if (c.isMesh && c.material && c.material.emissiveIntensity !== undefined) {
                    c.material.emissiveIntensity = 0;
                }
            });
        }
        this._prevHpRatio = hpRatio;
    }

    _spawnDamageSmoke(hpRatio) {
        if (this.exhaustParticles.length >= 22) return;
        const severe = hpRatio < 0.15;
        const color = severe ? 0x222222 : 0x555555;
        const size = severe ? 0.5 : 0.25;
        const puff = new THREE.Mesh(
            new THREE.SphereGeometry(size, 6, 5),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6 })
        );
        const pos = this.group.position;
        puff.position.set(
            pos.x + (Math.random() - 0.5) * 1.2,
            pos.y + 1.8 + Math.random() * 0.5,
            pos.z + (Math.random() - 0.5) * 1.0
        );
        this.scene.add(puff);
        this.exhaustParticles.push({
            mesh: puff, age: 0,
            maxAge: severe ? 2.0 : 1.2,
            vy: severe ? 2.5 : 1.5,
            vx: (Math.random() - 0.5) * 0.5,
            vz: -0.8,
            scaleRate: 3.0,
        });

        if (severe && Math.random() < 0.4) {
            const spark = new THREE.Mesh(
                new THREE.SphereGeometry(0.06, 4, 3),
                new THREE.MeshBasicMaterial({ color: 0xFF8822 })
            );
            spark.position.copy(puff.position);
            this.scene.add(spark);
            this.exhaustParticles.push({
                mesh: spark, age: 0, maxAge: 0.4,
                vy: 3, vx: (Math.random() - 0.5) * 3,
                vz: (Math.random() - 0.5) * 3, scaleRate: 0,
            });
        }
    }

    // ========================================
    // Feature 6: 手榴弾軌跡プレビュー
    // ========================================
    _makeTrajectoryLine() {
        const geo = new THREE.BufferGeometry();
        const positions = new Float32Array(60);
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.LineDashedMaterial({
            color: 0xFFFFAA, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.6,
        });
        const line = new THREE.Line(geo, mat);
        line.visible = false;
        this.scene.add(line);
        return line;
    }

    _updateGrenadePreview(input) {
        const heldG = input.grenadeHeld !== undefined ? input.grenadeHeld : false;
        if (!heldG || this.grenadeCount <= 0) {
            if (this.grenadeTrajectory) this.grenadeTrajectory.visible = false;
            return;
        }
        if (!this.grenadeTrajectory) return;
        this.grenadeTrajectory.visible = true;

        const startPos = this.group.position.clone();
        startPos.y += 1.5;
        const throwDir = new THREE.Vector3().subVectors(this.aimPoint, startPos);
        throwDir.y = 0;
        const throwDist = throwDir.length();
        throwDir.normalize();
        const speed = Math.min(throwDist * 1.2, 25);
        const v = new THREE.Vector3(throwDir.x * speed, 6 + throwDist * 0.15, throwDir.z * speed);
        const pos = startPos.clone();
        const positions = this.grenadeTrajectory.geometry.attributes.position.array;
        const simDt = 0.08;
        for (let i = 0; i < 20; i++) {
            positions[i * 3]     = pos.x;
            positions[i * 3 + 1] = Math.max(0.05, pos.y);
            positions[i * 3 + 2] = pos.z;
            v.y -= 20 * simDt;
            pos.addScaledVector(v, simDt);
            if (pos.y < 0) break;
        }
        this.grenadeTrajectory.geometry.attributes.position.needsUpdate = true;
        this.grenadeTrajectory.computeLineDistances();
    }

    getPosition() {
        return this.group.position.clone();
    }

    getAimPoint() {
        return this.aimPoint.clone();
    }

    getAimAngleDeg() {
        return this.aimAngleDeg;
    }

    getAimMode() {
        return this.aimMode;
    }
}
