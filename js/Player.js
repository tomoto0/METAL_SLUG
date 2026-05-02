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
        this.aimAngleDeg = 0; // UI 表示用（仰角度数）
        this.aimMode = 'lock'; // 'lock' (auto lock-on) only

        // ロックオン状態
        this.lockTarget = null;       // 現在ロック中の対象（敵 or 障害物 wrapper）
        this.lockTargetPos = new THREE.Vector3();
        this.lockHoldTimer = 0;       // 同一ターゲット維持時間（短時間切替防止）
        this.lockSearchInterval = 0.08; // 探索周期（秒）
        this.lockSearchTimer = 0;

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

        // 時限パワーアップ (Feature: power-ups)
        // 'BIG' = 太く大威力の砲弾 / 'SPREAD' = 三方向放射 / 'FLAME' = 火炎放射
        this.powerUp = null;
        this.powerUpTimer = 0;
        this.powerUpDuration = 0;

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
        this.aimAngleDeg = 0;
        this.aimMode = 'lock';
        this.lockTarget = null;
        this.lockHoldTimer = 0;
        this.lockSearchTimer = 0;
        this.velocityY = 0;
        this.isJumping = false;
        this.isCrouching = false;
        this.grenadeCount = this.maxGrenades;
        this.grenadeCooldown = 0;
        this.specialWeapon = null;
        this.specialAmmo = 0;
        this.powerUp = null;
        this.powerUpTimer = 0;
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
        // Concept 10 (sv001 concept art) 準拠: ほぼ黒のダークメタリック + 強い艶
        const C = {
            body:     0x2E3236,  // チャコール（メイン装甲）
            bodyHi:   0x6A7078,  // ハイライト（艶）
            bodyDk:   0x14171A,  // 深いシャドウ
            bodyMid:  0x42474D,  // 中間トーン
            track:    0x16181A,  // キャタピラ（ほぼ黒）
            trackIn:  0x232528,  // キャタピラ内側
            wheel:    0x2A2C30,  // ホイール
            wheelHub: 0x55585E,  // ハブ
            metal:    0x4A4D52,  // 砲身メタル（やや明るめ）
            metalDk:  0x1E2024,  // ダークメタル
            outline:  0x000000,  // 縁
            light:    0xFFD050,  // ヘッドライト（明るい黄）
            exhaust:  0x303236,  // 排気管
            hatch:    0x3A3E44,  // ハッチ
            flag:     0xDD2222,  // 旗
            mark:     0xFFCC22,  // 識別マーク用イエロー
            scope:    0xFFE060,  // ペリスコープのレンズ発光色
            rust:     0x7A4322,  // 錆/泥
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

            // 前方起動輪（さらに大きく、コンセプト 10 の存在感）
            const bigWheelMat = new THREE.MeshStandardMaterial({ color: C.wheel, roughness: 0.45, metalness: 0.55 });
            const frontWheelGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.22, 18);
            const frontWheel = new THREE.Mesh(frontWheelGeo, bigWheelMat);
            frontWheel.rotation.x = Math.PI / 2;
            frontWheel.position.set(1.25, trackH * 0.5, side * 0.08);
            tg.add(frontWheel);
            this.wheels.push(frontWheel);
            // フロントハブ（多角形リブ）
            const fhub = new THREE.Mesh(
                new THREE.CylinderGeometry(0.22, 0.22, 0.26, 8),
                new THREE.MeshStandardMaterial({ color: C.wheelHub, metalness: 0.7, roughness: 0.3 })
            );
            fhub.rotation.x = Math.PI / 2;
            fhub.position.copy(frontWheel.position);
            fhub.position.z += side * 0.06;
            tg.add(fhub);
            // ハブの中心ボルト
            const fhubBolt = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.08, 0.07, 6),
                new THREE.MeshStandardMaterial({ color: C.metalDk, metalness: 0.6 })
            );
            fhubBolt.rotation.x = Math.PI / 2;
            fhubBolt.position.copy(fhub.position);
            fhubBolt.position.z += side * 0.07;
            tg.add(fhubBolt);

            // 起動輪のスプロケット歯（外側の鋭い歯）
            const sprocketTeethMat = new THREE.MeshStandardMaterial({ color: C.metalDk, roughness: 0.6, metalness: 0.6 });
            for (let t = 0; t < 12; t++) {
                const ang = (t / 12) * Math.PI * 2;
                const tooth = new THREE.Mesh(
                    new THREE.BoxGeometry(0.12, 0.10, 0.08),
                    sprocketTeethMat
                );
                tooth.position.set(
                    frontWheel.position.x + Math.cos(ang) * 0.58,
                    frontWheel.position.y + Math.sin(ang) * 0.58,
                    side * 0.08
                );
                tooth.rotation.z = ang;
                tg.add(tooth);
            }

            // 後方誘導輪（大きい）
            const rearWheel = new THREE.Mesh(frontWheelGeo, bigWheelMat);
            rearWheel.rotation.x = Math.PI / 2;
            rearWheel.position.set(-1.25, trackH * 0.5, side * 0.08);
            tg.add(rearWheel);
            this.wheels.push(rearWheel);
            const rhub = fhub.clone();
            rhub.position.copy(rearWheel.position);
            rhub.position.z += side * 0.06;
            tg.add(rhub);
            const rhubBolt = fhubBolt.clone();
            rhubBolt.position.copy(rhub.position);
            rhubBolt.position.z += side * 0.07;
            tg.add(rhubBolt);

            // 中間転輪（3つ、コンセプトより大型）
            const midWheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.18, 14);
            for (const mx of [-0.5, 0.15, 0.8]) {
                const mw = new THREE.Mesh(midWheelGeo, bigWheelMat);
                mw.rotation.x = Math.PI / 2;
                mw.position.set(mx, trackH * 0.4, side * 0.06);
                tg.add(mw);
                this.wheels.push(mw);
                const mhub = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.13, 0.13, 0.22, 6),
                    new THREE.MeshStandardMaterial({ color: C.wheelHub, metalness: 0.65, roughness: 0.3 })
                );
                mhub.rotation.x = Math.PI / 2;
                mhub.position.copy(mw.position);
                mhub.position.z += side * 0.05;
                tg.add(mhub);
            }

            // 履帯クロウ歯（外周に並ぶグリッパー、コンセプト 10 の特徴）
            const clawMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.85, metalness: 0.2 });
            for (let cx = -1.45; cx <= 1.45; cx += 0.18) {
                const claw = new THREE.Mesh(
                    new THREE.BoxGeometry(0.13, 0.18, 0.10),
                    clawMat
                );
                claw.position.set(cx, 0.05, side * 0.06);
                tg.add(claw);
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

        // メインドーム（巨大半球、艶のあるメタリックブラック）
        const domeR = 1.05;
        const turretDome = new THREE.Mesh(
            new THREE.SphereGeometry(domeR, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.58),
            new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.32, metalness: 0.55 })
        );
        turretDome.castShadow = true;
        this.turretGroup.add(turretDome);

        // ドームハイライト（コンセプト 10 の白い光沢）
        const domeHi1 = new THREE.Mesh(
            new THREE.SphereGeometry(domeR + 0.012, 22, 16, Math.PI * 0.15, Math.PI * 0.5, Math.PI * 0.05, Math.PI * 0.32),
            new THREE.MeshStandardMaterial({ color: C.bodyHi, roughness: 0.18, metalness: 0.4 })
        );
        this.turretGroup.add(domeHi1);

        // ============== 黄色三角識別マーク（SV-001 アイコン） ==============
        // 砲塔正面（+X 側）に配置、ドーム表面にやや浮かせる
        const triShape = new THREE.Shape();
        const triR = 0.22;
        triShape.moveTo(0, triR);
        triShape.lineTo(triR * 0.95, -triR * 0.55);
        triShape.lineTo(-triR * 0.95, -triR * 0.55);
        triShape.lineTo(0, triR);
        const triGeo = new THREE.ShapeGeometry(triShape);
        const triMat = new THREE.MeshStandardMaterial({
            color: C.mark, emissive: C.mark, emissiveIntensity: 0.25,
            roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
        });
        const triangleMark = new THREE.Mesh(triGeo, triMat);
        // ドーム表面に貼り付けるため少し前傾＆少し上
        triangleMark.position.set(domeR * 0.78, domeR * 0.12, 0);
        triangleMark.rotation.y = Math.PI / 2;
        triangleMark.rotation.x = -0.05;
        this.turretGroup.add(triangleMark);

        // 三角の縁（黒アウトライン）
        const triOutlineGeo = new THREE.RingGeometry(triR * 0.88, triR * 1.05, 3);
        const triOutline = new THREE.Mesh(triOutlineGeo, new THREE.MeshBasicMaterial({ color: 0x000000 }));
        triOutline.position.copy(triangleMark.position);
        triOutline.position.x -= 0.005;
        triOutline.rotation.y = Math.PI / 2;
        triOutline.rotation.z = Math.PI / 6;
        this.turretGroup.add(triOutline);

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

        // ============== メインキャノン（太い、左側／上） ==============
        // コンセプト 10: 太く短い主砲、二段マズル、根元に厚いシュラウド
        const cannonShroud = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.24, 0.45, 12),
            bDkMat
        );
        cannonShroud.rotation.z = -Math.PI / 2;
        cannonShroud.position.set(0.25, 0.12, 0);
        this.cannonGroup.add(cannonShroud);

        const upperBarrel = new THREE.Mesh(
            new THREE.CylinderGeometry(0.13, 0.16, 1.7, 14),
            bMat
        );
        upperBarrel.rotation.z = -Math.PI / 2;
        upperBarrel.position.set(1.05, 0.12, 0);
        this.cannonGroup.add(upperBarrel);

        // 砲身節（主砲側、やや太め）
        for (const rx of [0.55, 0.95, 1.35]) {
            const seg = new THREE.Mesh(
                new THREE.TorusGeometry(0.165, 0.024, 8, 14),
                bDkMat
            );
            seg.rotation.y = Math.PI / 2;
            seg.position.set(rx, 0.12, 0);
            this.cannonGroup.add(seg);
        }

        // 二段マズルブレーキ（コンセプト 10）
        const muzzleStage1 = new THREE.Mesh(
            new THREE.CylinderGeometry(0.21, 0.16, 0.22, 12),
            bDkMat
        );
        muzzleStage1.rotation.z = -Math.PI / 2;
        muzzleStage1.position.set(2.02, 0.12, 0);
        this.cannonGroup.add(muzzleStage1);

        const muzzleStage2 = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.20, 0.16, 12),
            bMat
        );
        muzzleStage2.rotation.z = -Math.PI / 2;
        muzzleStage2.position.set(2.20, 0.12, 0);
        this.cannonGroup.add(muzzleStage2);

        // マズルブレーキの横スリット（4 方向）
        for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
            const slit = new THREE.Mesh(
                new THREE.BoxGeometry(0.08, 0.04, 0.22),
                new THREE.MeshStandardMaterial({ color: 0x000000 })
            );
            slit.position.set(2.05, 0.12 + Math.sin(ang) * 0.18, Math.cos(ang) * 0.18);
            this.cannonGroup.add(slit);
        }

        // ============== バルカン砲（6連バレル・クラスター、右側／下） ==============
        // コンセプト 10: 砲塔右側面から飛び出す多銃身ガトリング
        const vulcanCluster = new THREE.Group();
        const clusterR = 0.11;
        const barrelLen = 1.6;
        for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2;
            const bx = Math.cos(ang) * clusterR;
            const bz = Math.sin(ang) * clusterR;
            const bb = new THREE.Mesh(
                new THREE.CylinderGeometry(0.045, 0.045, barrelLen, 8),
                bMat
            );
            bb.rotation.z = -Math.PI / 2;
            bb.position.set(barrelLen / 2 + 0.3, bx, bz);
            vulcanCluster.add(bb);
        }
        // バレル束のシュラウド（円筒）
        const vulcanShroud = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.20, 0.36, 14),
            bDkMat
        );
        vulcanShroud.rotation.z = -Math.PI / 2;
        vulcanShroud.position.set(0.18, 0, 0);
        vulcanCluster.add(vulcanShroud);

        // バレル先端の固定リング
        const vulcanFrontRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.16, 0.025, 8, 16),
            bDkMat
        );
        vulcanFrontRing.rotation.y = Math.PI / 2;
        vulcanFrontRing.position.set(barrelLen + 0.18, 0, 0);
        vulcanCluster.add(vulcanFrontRing);
        const vulcanMidRing = vulcanFrontRing.clone();
        vulcanMidRing.position.set(barrelLen * 0.55 + 0.2, 0, 0);
        vulcanCluster.add(vulcanMidRing);

        // バルカンを下/右側へ配置（モデルの -Z 側 = ワールド右）
        vulcanCluster.position.set(0, -0.18, 0);
        this.vulcanGroup.add(vulcanCluster);
        this.vulcanCluster = vulcanCluster;

        this.cannonMuzzleAnchor = new THREE.Object3D();
        this.cannonMuzzleAnchor.position.set(2.30, 0.12, 0);
        this.cannonGroup.add(this.cannonMuzzleAnchor);

        this.vulcanMuzzleAnchor = new THREE.Object3D();
        this.vulcanMuzzleAnchor.position.set(barrelLen + 0.32, -0.18, 0);
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
        // ============== サーチライト/サイトポッド（前方上） ==============
        // コンセプト 10: 砲塔上前面に黄色いガラス入り大型ライト
        const searchPod = new THREE.Group();
        const podHousing = new THREE.Mesh(
            new THREE.CylinderGeometry(0.15, 0.18, 0.32, 14),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.4, metalness: 0.5 })
        );
        podHousing.rotation.z = -Math.PI / 2;
        searchPod.add(podHousing);

        const podLens = new THREE.Mesh(
            new THREE.CylinderGeometry(0.13, 0.13, 0.04, 14),
            new THREE.MeshStandardMaterial({
                color: C.scope, emissive: C.scope, emissiveIntensity: 0.85,
                roughness: 0.2, metalness: 0.1,
            })
        );
        podLens.rotation.z = -Math.PI / 2;
        podLens.position.set(0.16, 0, 0);
        searchPod.add(podLens);

        // 上部のショートチューブ（コンセプトの細長い小銃身）
        const podStub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.05, 0.5, 8),
            new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.3, metalness: 0.7 })
        );
        podStub.rotation.z = -Math.PI / 2;
        podStub.position.set(0.32, 0.16, 0);
        searchPod.add(podStub);

        // 取付アーム
        const podArm = new THREE.Mesh(
            new THREE.BoxGeometry(0.08, 0.18, 0.12),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.4 })
        );
        podArm.position.set(-0.05, -0.12, 0);
        searchPod.add(podArm);

        searchPod.position.set(0.55, domeR * 0.55, 0);
        this.turretGroup.add(searchPod);

        // ペリスコープ（後方上、小球）
        const periBase = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.08, 0.16, 8),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.4 })
        );
        periBase.position.set(-0.15, domeR * 0.55, 0);
        this.turretGroup.add(periBase);

        const periSphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 10, 8),
            new THREE.MeshStandardMaterial({ color: C.bodyMid, roughness: 0.3, metalness: 0.5 })
        );
        periSphere.position.set(-0.15, domeR * 0.55 + 0.16, 0);
        this.turretGroup.add(periSphere);

        // ペリスコープの黄色レンズ
        const periLens = new THREE.Mesh(
            new THREE.CircleGeometry(0.05, 12),
            new THREE.MeshStandardMaterial({
                color: C.scope, emissive: C.scope, emissiveIntensity: 0.6, side: THREE.DoubleSide,
            })
        );
        periLens.position.set(-0.05, domeR * 0.55 + 0.16, 0);
        periLens.rotation.y = Math.PI / 2;
        this.turretGroup.add(periLens);

        // ============== 2 本のアンテナ（コンセプト 10: 後方に長い 2 本） ==============
        const antMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.7 });
        const ant1 = new THREE.Mesh(
            new THREE.CylinderGeometry(0.014, 0.020, 1.4, 4),
            antMat
        );
        ant1.position.set(-0.35, domeR * 0.55 + 0.7, 0.12);
        ant1.rotation.z = 0.18;
        this.turretGroup.add(ant1);
        const ant1Tip = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 6, 5),
            new THREE.MeshStandardMaterial({ color: C.metalDk })
        );
        ant1Tip.position.set(-0.48, domeR * 0.55 + 1.4, 0.13);
        this.turretGroup.add(ant1Tip);

        const ant2 = new THREE.Mesh(
            new THREE.CylinderGeometry(0.012, 0.018, 1.1, 4),
            antMat
        );
        ant2.position.set(-0.45, domeR * 0.55 + 0.55, -0.12);
        ant2.rotation.z = 0.22;
        ant2.rotation.x = -0.05;
        this.turretGroup.add(ant2);
        const ant2Tip = ant1Tip.clone();
        ant2Tip.position.set(-0.6, domeR * 0.55 + 1.1, -0.13);
        this.turretGroup.add(ant2Tip);

        this.antennas = [ant1, ant2];

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

        // パワーアップタイマー
        if (this.powerUp && this.powerUpTimer > 0) {
            this.powerUpTimer -= dt;
            if (this.powerUpTimer <= 0) {
                this.powerUp = null;
                this.powerUpTimer = 0;
                this._clearSpecialWeaponGlow();
            }
        }

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

        // 障害物との衝突解決（大型建造物にはスタック、小型は破壊して通過）
        this._resolveObstacleCollisions();

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
        // チャージ最小閾値（50%）
        const CHARGE_MIN_RATIO = 0.5;
        if (input.altFireHeld) {
            if (!this.cannonCharging) {
                this.cannonCharging = true;
                this.cannonCharge = 0;
            }
            this.cannonCharge = Math.min(this.cannonCharge + dt, this.cannonChargeMax);
            if (this.barrelGroup) {
                const chargeRatio = this.cannonCharge / this.cannonChargeMax;
                const canFire = chargeRatio >= CHARGE_MIN_RATIO;
                this.barrelGroup.traverse(child => {
                    if (child.isMesh && child.material) {
                        child.material.emissive = child.material.emissive || new THREE.Color();
                        // 発射可能閾値に達したら色が変わる
                        if (canFire) {
                            // 50%到達: オレンジ→白へ段階的に変化
                            const firePhase = (chargeRatio - CHARGE_MIN_RATIO) / (1.0 - CHARGE_MIN_RATIO);
                            if (firePhase > 0.5) {
                                child.material.emissive.setHex(0x66CCFF); // 高チャージ: 青白
                            } else {
                                child.material.emissive.setHex(0xFF6600); // 中チャージ: オレンジ
                            }
                            child.material.emissiveIntensity = 0.3 + chargeRatio * 0.5;
                        } else {
                            child.material.emissive.setHex(0x442200); // 閾値未満: 暗い赤茶
                            child.material.emissiveIntensity = chargeRatio * 0.25;
                        }
                    }
                });
            }
        } else if (this.cannonCharging) {
            this.cannonCharging = false;
            // 50%未満のチャージでは発射できない（キャンセル扱い）
            const chargeRatio = this.cannonCharge / this.cannonChargeMax;
            if (chargeRatio >= 0.5) {
                this._fireChargedCannon(elapsedTime);
            } else {
                // チャージ不足 — リセットのみ
                this.cannonCharge = 0;
            }
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

        this.aimMode = 'lock';

        const minElev = -40 * Math.PI / 180;  // 下向き
        const maxElev =  85 * Math.PI / 180;  // 上向き（対空射撃のためほぼ真上まで許可）

        const turretWorldPos = new THREE.Vector3();
        this.turretGroup.getWorldPosition(turretWorldPos);

        // ============================================
        // 1) ロックオン対象を決定 → aimPoint を更新
        // ============================================
        this.lockSearchTimer -= dt;
        this.lockHoldTimer += dt;
        if (this.lockSearchTimer <= 0) {
            this.lockSearchTimer = this.lockSearchInterval;
            this._pickLockTarget(turretWorldPos);
        }

        if (this.lockTarget) {
            const tp = this._getLockTargetPosition(this.lockTarget);
            if (tp) {
                this.lockTargetPos.copy(tp);
                this.aimPoint.copy(tp);
            } else {
                this.lockTarget = null;
            }
        }

        if (!this.lockTarget) {
            // ターゲット無し: 砲塔前方 30m を狙点として保持（自然な前向き姿勢）
            this.aimPoint.set(turretWorldPos.x, 0.5, turretWorldPos.z + 30);
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

    /**
     * 候補から最良のロックオン対象を選択する。
     * 候補: 敵 (歩兵・戦車・航空機) → ボス → 破壊可能オブジェクト
     * スコア = 距離 * クラス重み + 後方ペナルティ。低いほど良い。
     * 同じ対象を維持しやすくする stickiness を加味。
     */
    _pickLockTarget(turretWorldPos) {
        const MAX_DIST = 60;
        const FORWARD_BIAS_RAD = 0.9; // 前方半円外は強いペナルティ
        let best = null;
        let bestScore = Infinity;
        const _v = new THREE.Vector3();

        const evalCandidate = (entity, pos, classWeight) => {
            if (!pos) return;
            _v.set(pos.x - turretWorldPos.x, 0, pos.z - turretWorldPos.z);
            const dist = _v.length();
            if (dist < 0.5 || dist > MAX_DIST) return;
            // ヨー差: 真前(+Z) を 0 とする
            const yaw = Math.atan2(_v.x, _v.z);
            const yawAbs = Math.abs(yaw);
            // 前方優先: 後方半球は大きなペナルティ
            const behindPenalty = yawAbs > Math.PI / 2 ? (yawAbs - Math.PI / 2) * 18 : 0;
            // 視野外（FORWARD_BIAS_RAD ~ 51°）から外れる分も少しペナルティ
            const offCenterPenalty = Math.max(0, yawAbs - FORWARD_BIAS_RAD) * 8;
            // sticky: 直前のロック対象は割引
            const stickyBonus = (this.lockTarget === entity) ? -6 : 0;
            const score = dist * classWeight + behindPenalty + offCenterPenalty + stickyBonus;
            if (score < bestScore) {
                bestScore = score;
                best = entity;
            }
        };

        // 1) 敵
        const enemies = this.getEnemies ? this.getEnemies() : null;
        if (enemies && enemies.length > 0) {
            for (const e of enemies) {
                if (!e || !e.alive) continue;
                const pos = (e.getPosition && e.getPosition()) || (e.group && e.group.position);
                evalCandidate(e, pos, 1.0);
            }
        }

        // 2) ボス（脅威度高: 重みを軽くして優先）
        if (this.getBoss) {
            const boss = this.getBoss();
            if (boss && boss.alive) {
                const bp = (boss.getPosition && boss.getPosition()) || (boss.group && boss.group.position);
                evalCandidate(boss, bp, 0.6);
            }
        }

        // 3) 破壊可能オブジェクト（敵が無いときの保険として、重みを大きく）
        if (this.world && typeof this.world.getObstacles === 'function') {
            const obstacles = this.world.getObstacles();
            for (const entry of obstacles) {
                if (!entry || !entry.info) continue;
                if (entry.info.type !== 'destructible' || entry.info.destroyed) continue;
                evalCandidate(entry, entry.obj.position, 2.5);
            }
        }

        this.lockTarget = best;
        if (best) this.lockHoldTimer = 0;
    }

    _getLockTargetPosition(target) {
        if (!target) return null;
        // 障害物 entry は { obj, info } 形式
        if (target.obj && target.info) {
            if (target.info.destroyed) return null;
            return target.obj.position;
        }
        // 敵 / ボス
        if (target.alive === false) return null;
        if (target.getPosition) return target.getPosition();
        if (target.group && target.group.position) return target.group.position;
        return null;
    }

    _fireVulcan(elapsedTime) {
        // 特殊武器の連射レート（原作準拠）
        // H(HEAVY MG): 2倍連射、R(ROCKET): 低レート高威力、F(FLAME): 連射短射程、S(SHOTGUN): 拡散低レート
        if (this.specialWeapon === 'H') this.fireRate = 0.065;
        else if (this.specialWeapon === 'R') this.fireRate = 0.35;
        else if (this.specialWeapon === 'F') this.fireRate = 0.10;
        else if (this.specialWeapon === 'S') this.fireRate = 0.40;
        else this.fireRate = this.baseFireRate;

        // パワーアップ中は連射レート上書き
        if (this.powerUp === 'BIG')    this.fireRate = 0.18;
        if (this.powerUp === 'SPREAD') this.fireRate = 0.16;
        if (this.powerUp === 'FLAME')  this.fireRate = 0.045; // 高速連続噴射

        if (elapsedTime - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsedTime;

        // パワーアップは特殊武器より優先
        if (this.powerUp) {
            this._firePowerUp(elapsedTime);
            return;
        }
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
        // チャージ完了時は常に発射する（クールダウンで破棄しない）。
        // 連射防止は連打しない限り問題にならず、誤って弾を消す方がはるかにマズい。
        this.lastCannonTime = elapsedTime;
        const chargeRatio = Math.max(0.2, this.cannonCharge / this.cannonChargeMax);

        const muzzleWorldPos = new THREE.Vector3();
        if (this.cannonMuzzleAnchor) {
            this.cannonMuzzleAnchor.getWorldPosition(muzzleWorldPos);
        } else if (this.barrelGroup) {
            this.barrelGroup.getWorldPosition(muzzleWorldPos);
        } else {
            muzzleWorldPos.copy(this.group.position).add(new THREE.Vector3(0, 1.6, 0));
        }

        const fireDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
        // aimPoint と muzzle がほぼ同点だった場合のフォールバック（NaN 回避）
        if (fireDir.lengthSq() < 1e-6) fireDir.set(0, 0, 1);
        fireDir.normalize();

        // チャージ段階を 3 ティアに分け、視覚効果と威力を切り替える
        // tier: 0 = LOW(<0.4)  1 = MID(0.4-0.75)  2 = HIGH(>=0.75)
        let tier = 0;
        if (chargeRatio >= 0.75) tier = 2;
        else if (chargeRatio >= 0.4) tier = 1;

        const tierConfig = [
            { color: 0xFF8833, scale: 1.4, blastMul: 1.0,  damageMul: 1.0, explosion: 'large', flashColor: 0xFF7733, recoilMul: 1.0 },
            { color: 0xFFCC22, scale: 2.0, blastMul: 1.4,  damageMul: 1.4, explosion: 'large', flashColor: 0xFFAA22, recoilMul: 1.4 },
            { color: 0xFFFFFF, scale: 2.8, blastMul: 1.9,  damageMul: 1.9, explosion: 'mega',  flashColor: 0x66CCFF, recoilMul: 1.9 },
        ];
        const cfg = tierConfig[tier];

        const damage = Math.floor((55 + chargeRatio * 145) * cfg.damageMul);
        const shell = new Projectile(this.scene, {
            position: muzzleWorldPos,
            direction: fireDir,
            speed: 32 + chargeRatio * 12,
            damage: damage,
            owner: 'player',
            type: 'cannon',
            maxDistance: 120,
            hitRadius: 0.4 + chargeRatio * 0.5,
            blastRadius: (4.2 + chargeRatio * 2.8) * cfg.blastMul,
            explosionVisual: cfg.explosion,
        });
        if (shell.group) {
            shell.group.scale.setScalar(cfg.scale);
            // 弾体の色をチャージティアに合わせて再着色（共有マテリアルは触らず子マテリアルを置換）
            shell.group.traverse(child => {
                if (child.isMesh && child.material && child.material.color) {
                    const newMat = child.material.clone();
                    newMat.color.setHex(cfg.color);
                    child.material = newMat;
                }
            });
            // 高チャージ時は弾そのものに発光を追加
            if (tier >= 1) {
                const aura = new THREE.PointLight(cfg.color, tier === 2 ? 4 : 2, 8);
                shell.group.add(aura);
            }
        }
        this.projectiles.push(shell);

        // マズルフラッシュ: ティアに応じて巨大化
        const flash = new Explosion(this.scene, muzzleWorldPos, {
            type: 'muzzle', color: cfg.flashColor,
        });
        if (flash.group) flash.group.scale.setScalar(1.0 + tier * 0.7);
        this.effects.push(flash);

        // チャージ最大時は画面シェイク
        if (this.onChargeFire) this.onChargeFire(tier);

        this.barrelRecoil = 1.0 * cfg.recoilMul;
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

    /**
     * 障害物との衝突解決:
     *  - 'block' (大型建造物): 円-円押し戻し → 戦車がスタックする
     *  - 'destructible' (小型障害): 接触で破壊し小爆発、戦車は減速して通過
     */
    _resolveObstacleCollisions() {
        if (!this.world || typeof this.world.getObstacles !== 'function') return;
        const tankRadius = 1.6;
        const obstacles = this.world.getObstacles();
        const tankWX = this.localOffsetX;
        const tankWZ = this.scrollZ + this.localOffsetZ;
        for (const { obj, info } of obstacles) {
            const dx = tankWX - obj.position.x;
            const dz = tankWZ - obj.position.z;
            const distSq = dx * dx + dz * dz;
            const minDist = tankRadius + info.radius;
            if (distSq >= minDist * minDist) continue;

            if (info.type === 'block') {
                const dist = Math.sqrt(distSq);
                if (dist < 0.0001) continue;
                const overlap = minDist - dist;
                const nx = dx / dist;
                const nz = dz / dist;
                this.localOffsetX += nx * overlap;
                this.localOffsetZ += nz * overlap;
                // 衝突方向の速度を殺す（スタック感）
                const vDot = this.velocityX * nx + this.velocityZ * nz;
                if (vDot < 0) {
                    this.velocityX -= nx * vDot;
                    this.velocityZ -= nz * vDot;
                }
                this.localOffsetX = Math.max(-8, Math.min(8, this.localOffsetX));
                this.localOffsetZ = Math.max(-12, Math.min(15, this.localOffsetZ));
            } else if (info.type === 'destructible') {
                info.hp -= 1;
                if (info.hp <= 0) {
                    const pos = new THREE.Vector3(obj.position.x, 0.4, obj.position.z);
                    this.world.destroyObstacle(obj);
                    const exp = new Explosion(this.scene, pos, { type: 'small' });
                    this.effects.push(exp);
                    if (this.soundManager && this.soundManager.playExplosionSmall) {
                        this.soundManager.playExplosionSmall();
                    }
                }
                // 通過は許すが減速（潰した手応え）
                this.velocityX *= 0.7;
                this.velocityZ *= 0.7;
            }
        }
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
    // 時限パワーアップ: BIG / SPREAD / FLAME
    // 弾数ではなく時間で切れる。特殊武器(H/R/F/S)とは独立。
    // ========================================
    applyPowerUp(code, duration) {
        const valid = code === 'BIG' || code === 'SPREAD' || code === 'FLAME';
        if (!valid) return;
        this.powerUp = code;
        this.powerUpTimer = duration;
        this.powerUpDuration = duration;
        // 視覚: 砲身に色付き発光
        const colorMap = { BIG: 0xFF44AA, SPREAD: 0x44CCFF, FLAME: 0xFF7711 };
        if (this.vulcanGroup) {
            this.vulcanGroup.traverse(c => {
                if (c.isMesh && c.material) {
                    if (!c.material.emissive) c.material.emissive = new THREE.Color();
                    c.material.emissive.setHex(colorMap[code]);
                    c.material.emissiveIntensity = 0.6;
                }
            });
        }
    }

    _firePowerUp(elapsedTime) {
        const muzzleWorldPos = new THREE.Vector3();
        if (this.vulcanMuzzleAnchor) this.vulcanMuzzleAnchor.getWorldPosition(muzzleWorldPos);
        else this.vulcanGroup.getWorldPosition(muzzleWorldPos);
        const baseDir = new THREE.Vector3().subVectors(this.aimPoint, muzzleWorldPos);
        if (baseDir.lengthSq() < 0.01) return;
        baseDir.normalize();

        switch (this.powerUp) {
            case 'BIG': {
                // 太く大威力。爆風付き、貫通気味（高HP）。
                // 視覚的に「砲弾」っぽく見せるため type:'cannon' を流用。
                const big = new Projectile(this.scene, {
                    position: muzzleWorldPos, direction: baseDir,
                    speed: 46, damage: 45, owner: 'player', type: 'cannon',
                    maxDistance: 110,
                    blastRadius: 2.2,
                    hitRadius: 0.6,
                });
                // 太く見せる
                big.group.scale.set(1.6, 1.6, 1.8);
                this.projectiles.push(big);
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0xFF44AA });
                this.effects.push(flash);
                this.vulcanRecoil = 1.6;
                this._spawnShellCasing();
                if (this.soundManager) this.soundManager.playCannon && this.soundManager.playCannon();
                break;
            }
            case 'SPREAD': {
                // 三方向放射: 中央 + ±15°
                for (const offsetDeg of [-15, 0, 15]) {
                    const a = THREE.MathUtils.degToRad(offsetDeg);
                    const d = baseDir.clone();
                    // Y軸周り回転（地表面方向の拡散）
                    const cos = Math.cos(a), sin = Math.sin(a);
                    const nx = d.x * cos - d.z * sin;
                    const nz = d.x * sin + d.z * cos;
                    d.set(nx, d.y, nz).normalize();
                    const bullet = new Projectile(this.scene, {
                        position: muzzleWorldPos.clone(), direction: d,
                        speed: 52, damage: 14, owner: 'player', type: 'bullet', maxDistance: 90,
                    });
                    bullet.group.scale.set(1.3, 1.3, 1.3);
                    // 弾色を水色寄りに
                    bullet.group.traverse(c => {
                        if (c.isMesh && c.material && c.material.color) {
                            c.material.color.setHex(0x88DDFF);
                        }
                    });
                    this.projectiles.push(bullet);
                }
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0x44CCFF });
                this.effects.push(flash);
                this.vulcanRecoil = 1.0;
                this._spawnShellCasing();
                if (this.soundManager) this.soundManager.playVulcan && this.soundManager.playVulcan();
                break;
            }
            case 'FLAME': {
                // 火炎放射: 短射程・連続噴射・高頻度の小炎弾。
                // 1発につき 2-3 個ばら撒くと「炎の帯」に見える。
                for (let i = 0; i < 3; i++) {
                    const d = baseDir.clone();
                    d.x += (Math.random() - 0.5) * 0.18;
                    d.y += (Math.random() - 0.5) * 0.08;
                    d.z += (Math.random() - 0.5) * 0.18;
                    d.normalize();
                    const flame = new Projectile(this.scene, {
                        position: muzzleWorldPos.clone(), direction: d,
                        speed: 22, damage: 9, owner: 'player', type: 'bullet', maxDistance: 14,
                    });
                    flame.group.scale.set(2.0, 2.0, 2.2);
                    // 弾を炎色に
                    flame.group.traverse(c => {
                        if (c.isMesh && c.material && c.material.color) {
                            const hot = i === 0 ? 0xFFEE66 : (i === 1 ? 0xFF8822 : 0xFF3300);
                            c.material.color.setHex(hot);
                            if (c.material.transparent !== undefined) {
                                c.material.transparent = true;
                                c.material.opacity = 0.9;
                            }
                        }
                    });
                    this.projectiles.push(flame);
                }
                const flash = new Explosion(this.scene, muzzleWorldPos, { type: 'muzzle', color: 0xFF7711 });
                this.effects.push(flash);
                this.vulcanRecoil = 0.4;
                if (this.soundManager) this.soundManager.playVulcan && this.soundManager.playVulcan();
                break;
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
