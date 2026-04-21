import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

/**
 * 歩兵系の敵
 * subType: 'rifle' | 'knife' | 'rocket' | 'shield'
 *
 * Metal Slug風: 巨大ヘルメット(頭=体の1/3)、ずんぐり体型
 */
export class Infantry extends Enemy {
    constructor(scene, {
        position,
        subType = 'rifle',
    }) {
        // Metal Slug 原作準拠チューニング
        // - 歩兵は基本 1HP 換算（バルカン 1〜2 発）で倒せるのが原則
        // - スコアは rebel army の典型値 (rifle 100 / knife 200 / grenade 200 /
        //   machinegun 400 / officer 600) に合わせる
        // - shield 兵は正面 45% ダメージ軽減があるため実質 HP 高め
        const SPECS = {
            rifle:      { hp: 8,  speed: 3.0, scoreValue: 100, fireRate: 1.5, damage: 5  },
            knife:      { hp: 6,  speed: 6.5, scoreValue: 200, fireRate: 99,  damage: 15 },
            rocket:     { hp: 10, speed: 2.5, scoreValue: 300, fireRate: 2.5, damage: 15 },
            shield:     { hp: 30, speed: 2.0, scoreValue: 400, fireRate: 2.0, damage: 10 },
            grenade:    { hp: 10, speed: 3.0, scoreValue: 200, fireRate: 2.5, damage: 20 },
            machinegun: { hp: 20, speed: 2.2, scoreValue: 400, fireRate: 2.5, damage: 5  },
            officer:    { hp: 40, speed: 4.5, scoreValue: 600, fireRate: 1.2, damage: 10 },
        };
        const spec = SPECS[subType] || SPECS.rifle;

        super(scene, { position, ...spec, type: 'infantry' });
        this.subType = subType;

        // AI状態
        this.aiState = 'advance';  // 'advance' | 'attack' | 'charge'
        this.attackRange = subType === 'rocket' ? 25 : (subType === 'knife' ? 2 : 15);
        this.walkCycle = 0;
        this.alertDelay = 0.5 + Math.random() * 1.0; // 出現後の遅延
        this.timeSinceSpawn = 0;

        this.burstCount = 0;
        this.burstTimer = 0;

        // 射程を通る導線（スポーン時は null、最初の update でプレイヤー側から決定）
        this.crossTargetX = null;
        this.crossTargetZ = null;
        this.weavePhase = Math.random() * Math.PI * 2;

        this._buildModel();
        this._recordMaterials();
        this.scene.add(this.group);
    }

    _buildModel() {
        // ============================================
        // Metal Slug Rebel Army スプライトシート準拠デザイン
        // 特徴: 大きな頭/ヘルメット、ずんぐり体型、大きなバックパック
        // オリーブ/タン/ブラウン系の軍服
        // ============================================
        const COLORS = {
            helmet: 0x5D7835,     // 鮮やかなオリーブグリーンヘルメット
            helmetBand: 0x9A8A60, // ヘルメットバンド
            uniform: 0x6B8840,    // Metal Slug風明るいオリーブ軍服
            uniformDark: 0x4A6830, // ダーク軍服
            vest: 0x9A8858,       // ベスト/装備
            skin: 0xF0CCA0,       // 明るい肌色
            skinDark: 0xD0A878,   // 肌色（影）
            boots: 0x553828,      // ブーツ
            metal: 0x555555,      // 金属
            metalLight: 0x777777, // 明るい金属
            shield: 0x5A7A48,     // シールド
            red: 0xAA3322,        // 赤（ナイフ兵）
            redBandana: 0xDD3333, // 赤バンダナ
            tan: 0xCCB080,        // タン（士官）
            blue: 0x4060AA,       // 青（ロケット兵）
            darkGray: 0x3A3A3A,   // ダークグレー
            backpack: 0x887850,   // バックパック（タン色）
        };

        // サブタイプ別に色を変更
        if (this.subType === 'knife') {
            COLORS.uniform = 0xBB3322;
            COLORS.uniformDark = 0x882222;
            COLORS.helmet = 0x3A3A3A; // ダークヘルメット
        } else if (this.subType === 'rocket') {
            COLORS.uniform = 0x4468BB;
            COLORS.uniformDark = 0x3350AA;
            COLORS.vest = 0x777768;
        } else if (this.subType === 'machinegun') {
            COLORS.uniform = 0x5B5B5B;
            COLORS.uniformDark = 0x3B3B3B;
            COLORS.helmet = 0x2A2A2A;
        } else if (this.subType === 'officer') {
            COLORS.uniform = COLORS.tan;
            COLORS.uniformDark = 0xAA9870;
            COLORS.helmet = 0xCC3333;
            COLORS.vest = 0xBBAA88;
        } else if (this.subType === 'grenade') {
            COLORS.uniform = 0x7B7B5B;
            COLORS.vest = 0x9B8B6B;
        }

        // ============================================
        // 脚（2本、歩行アニメ用に分離）
        // ============================================
        this.leftLeg = new THREE.Group();
        this.rightLeg = new THREE.Group();

        // ブーツ（大きめ、ゴツい）
        const bootGeo = new THREE.BoxGeometry(0.28, 0.32, 0.28);
        const bootMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.9 });

        // レッグガード（ゲートル）
        const gaitersGeo = new THREE.BoxGeometry(0.22, 0.15, 0.24);
        const gaitersMat = new THREE.MeshStandardMaterial({ color: 0x8B7B5B, roughness: 0.8 });

        const legGeo = new THREE.BoxGeometry(0.2, 0.35, 0.22);
        const legMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.8 });

        // 左脚
        const lBoot = new THREE.Mesh(bootGeo, bootMat);
        lBoot.position.y = 0.16;
        this.leftLeg.add(lBoot);
        const lGaiters = new THREE.Mesh(gaitersGeo, gaitersMat);
        lGaiters.position.y = 0.35;
        this.leftLeg.add(lGaiters);
        const lLeg = new THREE.Mesh(legGeo, legMat);
        lLeg.position.y = 0.52;
        this.leftLeg.add(lLeg);
        this.leftLeg.position.set(0, 0, -0.16);
        this.group.add(this.leftLeg);

        // 右脚
        const rBoot = new THREE.Mesh(bootGeo, bootMat.clone());
        rBoot.position.y = 0.16;
        this.rightLeg.add(rBoot);
        const rGaiters = new THREE.Mesh(gaitersGeo, gaitersMat.clone());
        rGaiters.position.y = 0.35;
        this.rightLeg.add(rGaiters);
        const rLeg = new THREE.Mesh(legGeo, legMat.clone());
        rLeg.position.y = 0.52;
        this.rightLeg.add(rLeg);
        this.rightLeg.position.set(0, 0, 0.16);
        this.group.add(this.rightLeg);

        // ============================================
        // 胴体（ずんぐり、厚みのある）
        // ============================================
        const torsoGeo = new THREE.BoxGeometry(0.5, 0.5, 0.55);
        const torsoMat = new THREE.MeshStandardMaterial({ color: COLORS.uniform, roughness: 0.8 });
        const torso = new THREE.Mesh(torsoGeo, torsoMat);
        torso.position.y = 0.95;
        torso.castShadow = true;
        this.group.add(torso);

        // ベスト/装備ハーネス（スプライトシートの特徴）
        const vestGeo = new THREE.BoxGeometry(0.52, 0.35, 0.57);
        const vestMat = new THREE.MeshStandardMaterial({ color: COLORS.vest, roughness: 0.85 });
        const vest = new THREE.Mesh(vestGeo, vestMat);
        vest.position.y = 0.88;
        this.group.add(vest);

        // ベルト（太め）
        const beltGeo = new THREE.BoxGeometry(0.54, 0.08, 0.58);
        const beltMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.7 });
        const belt = new THREE.Mesh(beltGeo, beltMat);
        belt.position.y = 0.72;
        this.group.add(belt);

        // ベルトバックル
        const buckleGeo = new THREE.BoxGeometry(0.1, 0.06, 0.1);
        const buckleMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.6, roughness: 0.3 });
        const buckle = new THREE.Mesh(buckleGeo, buckleMat);
        buckle.position.set(0.28, 0.72, 0);
        this.group.add(buckle);

        // ============================================
        // 腕（太め、袖まくり）
        // ============================================
        const armGeo = new THREE.BoxGeometry(0.16, 0.38, 0.16);
        const armMat = new THREE.MeshStandardMaterial({ color: COLORS.uniform, roughness: 0.8 });
        const leftArm = new THREE.Mesh(armGeo, armMat);
        leftArm.position.set(0, 0.9, -0.38);
        this.group.add(leftArm);

        const rightArm = new THREE.Mesh(armGeo, armMat.clone());
        rightArm.position.set(0, 0.9, 0.38);
        this.group.add(rightArm);

        // 手（肌色）
        const handGeo = new THREE.SphereGeometry(0.06, 6, 4);
        const handMat = new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.8 });
        const leftHand = new THREE.Mesh(handGeo, handMat);
        leftHand.position.set(0, 0.72, -0.38);
        this.group.add(leftHand);
        const rightHand = new THREE.Mesh(handGeo, handMat.clone());
        rightHand.position.set(0, 0.72, 0.38);
        this.group.add(rightHand);

        // ============================================
        // 頭（巨大 = 体全体の約1/3）Metal Slug最大の特徴
        // ============================================
        const headGeo = new THREE.SphereGeometry(0.3, 12, 10);
        const headMat = new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.75 });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.38;
        head.scale.set(1.0, 0.95, 0.9);
        this.group.add(head);

        // 顔の影（下半分）
        const chinGeo = new THREE.SphereGeometry(0.22, 8, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.3);
        const chinMat = new THREE.MeshStandardMaterial({ color: COLORS.skinDark, roughness: 0.8 });
        const chin = new THREE.Mesh(chinGeo, chinMat);
        chin.position.y = 1.32;
        chin.scale.set(1.0, 0.9, 0.85);
        this.group.add(chin);

        // ============================================
        // ヘルメット（巨大なシュタールヘルム）
        // ============================================
        const helmetGeo = new THREE.SphereGeometry(0.35, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6);
        const helmetMat = new THREE.MeshStandardMaterial({
            color: COLORS.helmet, roughness: 0.5, metalness: 0.2
        });
        const helmet = new THREE.Mesh(helmetGeo, helmetMat);
        helmet.position.y = 1.46;
        helmet.scale.set(1.1, 0.9, 1.05);
        helmet.castShadow = true;
        this.group.add(helmet);

        // ヘルメットのつば（大きめ）
        const brimGeo = new THREE.CylinderGeometry(0.38, 0.4, 0.05, 14, 1, false, 0, Math.PI);
        const brimMat = new THREE.MeshStandardMaterial({ color: COLORS.helmet, roughness: 0.5 });
        const brim = new THREE.Mesh(brimGeo, brimMat);
        brim.position.set(0.12, 1.32, 0);
        brim.rotation.z = Math.PI / 2;
        brim.rotation.y = -Math.PI / 2;
        this.group.add(brim);

        // ヘルメットバンド（スプライトシートの特徴）
        if (this.subType !== 'officer') {
            const bandGeo = new THREE.TorusGeometry(0.33, 0.02, 6, 16);
            const bandMat = new THREE.MeshStandardMaterial({ color: COLORS.helmetBand, roughness: 0.7 });
            const band = new THREE.Mesh(bandGeo, bandMat);
            band.position.y = 1.42;
            band.rotation.x = Math.PI / 2;
            band.scale.set(1.05, 1.0, 0.6);
            this.group.add(band);
        }

        // 目（白目+黒目、表情豊か。concept art 風の大きな目）
        const scleraGeo = new THREE.SphereGeometry(0.06, 8, 6);
        const scleraMat = new THREE.MeshBasicMaterial({ color: 0xF8F4E8 });
        const pupilGeo = new THREE.SphereGeometry(0.035, 6, 4);
        const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
        // 怒り・殺気の表情: サブタイプごとに瞳位置をわずかに変える
        const gazeZ = this.subType === 'knife' ? 0.025 : (this.subType === 'officer' ? 0.015 : 0.01);
        for (let z of [-0.12, 0.12]) {
            const sclera = new THREE.Mesh(scleraGeo, scleraMat);
            sclera.position.set(0.23, 1.36, z);
            sclera.scale.set(0.7, 1.0, 1.0);
            this.group.add(sclera);
            const pupil = new THREE.Mesh(pupilGeo, pupilMat.clone ? pupilMat.clone() : pupilMat);
            pupil.position.set(0.27, 1.36, z + (z > 0 ? -gazeZ : gazeZ));
            pupil.scale.set(0.6, 1.0, 1.0);
            this.group.add(pupil);
        }

        // 眉（怒り眉 / concept art 風の濃い表情）
        const browGeo = new THREE.BoxGeometry(0.02, 0.025, 0.1);
        const browMat = new THREE.MeshBasicMaterial({ color: 0x221a12 });
        const isAngry = ['knife', 'officer', 'machinegun', 'rocket', 'grenade'].includes(this.subType);
        for (let side of [-1, 1]) {
            const brow = new THREE.Mesh(browGeo, browMat);
            brow.position.set(0.28, 1.44, side * 0.12);
            brow.rotation.x = isAngry ? side * -0.5 : 0; // 怒り眉 (逆ハ)
            this.group.add(brow);
        }

        // 口（叫び / 不敵な笑み / 真一文字、サブタイプで切替）
        const yellingTypes = ['knife', 'machinegun', 'rocket', 'grenade'];
        if (yellingTypes.includes(this.subType)) {
            // 叫び口（開口 = 黒い穴 + 歯）
            const mouthOpenGeo = new THREE.BoxGeometry(0.02, 0.08, 0.11);
            const mouthOpenMat = new THREE.MeshBasicMaterial({ color: 0x1a0808 });
            const mouthOpen = new THREE.Mesh(mouthOpenGeo, mouthOpenMat);
            mouthOpen.position.set(0.28, 1.24, 0);
            this.group.add(mouthOpen);
            const teethGeo = new THREE.BoxGeometry(0.01, 0.02, 0.1);
            const teethMat = new THREE.MeshBasicMaterial({ color: 0xF0E8D0 });
            const teeth = new THREE.Mesh(teethGeo, teethMat);
            teeth.position.set(0.29, 1.265, 0);
            this.group.add(teeth);
        } else {
            // 真一文字 or 冷笑
            const mouthGeo = new THREE.BoxGeometry(0.01, 0.02, 0.1);
            const mouthMat = new THREE.MeshBasicMaterial({ color: 0x3a2020 });
            const mouth = new THREE.Mesh(mouthGeo, mouthMat);
            mouth.position.set(0.28, 1.26, 0);
            this.group.add(mouth);
        }

        // 鼻（小さく。出っ張り）
        const noseGeo = new THREE.SphereGeometry(0.04, 6, 4);
        const noseMat = new THREE.MeshStandardMaterial({ color: COLORS.skinDark, roughness: 0.8 });
        const nose = new THREE.Mesh(noseGeo, noseMat);
        nose.position.set(0.31, 1.3, 0);
        nose.scale.set(0.7, 0.9, 0.7);
        this.group.add(nose);

        // 士官のヒゲ
        if (this.subType === 'officer') {
            const moustacheGeo = new THREE.BoxGeometry(0.015, 0.03, 0.18);
            const moustacheMat = new THREE.MeshBasicMaterial({ color: 0x2a1a10 });
            const moustache = new THREE.Mesh(moustacheGeo, moustacheMat);
            moustache.position.set(0.3, 1.28, 0);
            this.group.add(moustache);
        }

        // ============================================
        // バックパック（大きめ、スプライトシートの特徴）
        // ============================================
        if (this.subType !== 'officer' && this.subType !== 'knife') {
            // 大型バックパック
            const packGeo = new THREE.BoxGeometry(0.35, 0.5, 0.3);
            const packMat = new THREE.MeshStandardMaterial({ color: COLORS.backpack, roughness: 0.9 });
            const pack = new THREE.Mesh(packGeo, packMat);
            pack.position.set(-0.38, 0.9, 0);
            this.group.add(pack);

            // バックパックストラップ
            const strapGeo = new THREE.BoxGeometry(0.04, 0.45, 0.04);
            const strapMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.8 });
            for (let z of [-0.1, 0.1]) {
                const strap = new THREE.Mesh(strapGeo, strapMat);
                strap.position.set(-0.15, 0.95, z);
                this.group.add(strap);
            }

            // バックパックのフラップ
            const flapGeo = new THREE.BoxGeometry(0.3, 0.08, 0.28);
            const flapMat = new THREE.MeshStandardMaterial({ color: COLORS.backpack, roughness: 0.85 });
            const flap = new THREE.Mesh(flapGeo, flapMat);
            flap.position.set(-0.38, 1.18, 0);
            this.group.add(flap);

            // バックパックのポーチ
            if (this.subType === 'grenade' || this.subType === 'rifle') {
                const pouchGeo = new THREE.BoxGeometry(0.12, 0.15, 0.12);
                const pouchMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.9 });
                const pouch = new THREE.Mesh(pouchGeo, pouchMat);
                pouch.position.set(-0.38, 0.58, 0.15);
                this.group.add(pouch);
            }
        } else if (this.subType === 'knife') {
            // ナイフ兵は小型バックパック
            const smallPackGeo = new THREE.BoxGeometry(0.2, 0.25, 0.2);
            const smallPackMat = new THREE.MeshStandardMaterial({ color: COLORS.darkGray, roughness: 0.9 });
            const smallPack = new THREE.Mesh(smallPackGeo, smallPackMat);
            smallPack.position.set(-0.3, 0.85, 0);
            this.group.add(smallPack);
        }

        // ナイフ兵のバンダナ
        if (this.subType === 'knife') {
            const bandanaGeo = new THREE.BoxGeometry(0.02, 0.06, 0.35);
            const bandanaMat = new THREE.MeshStandardMaterial({ color: COLORS.redBandana, roughness: 0.8 });
            const bandana = new THREE.Mesh(bandanaGeo, bandanaMat);
            bandana.position.set(-0.15, 1.45, 0);
            this.group.add(bandana);
        }

        // 士官のベレー帽
        if (this.subType === 'officer') {
            // ベレー帽のツバを大きく
            const capBrimGeo = new THREE.CylinderGeometry(0.3, 0.32, 0.03, 12);
            const capBrimMat = new THREE.MeshStandardMaterial({ color: COLORS.tan, roughness: 0.6 });
            const capBrim = new THREE.Mesh(capBrimGeo, capBrimMat);
            capBrim.position.set(0, 1.5, 0);
            this.group.add(capBrim);
        }

        // ============================================
        // サブタイプ別アクセサリー（concept art 風の特徴表現）
        // ============================================
        this._buildSubtypeGear(COLORS);

        // ============================================
        // 武器（サブタイプ別）
        // ============================================
        this._buildWeapon(COLORS);

        // 全体スケール調整（少し大きめにして当たり判定を改善）
        this.group.scale.setScalar(1.15);
    }

    _buildSubtypeGear(COLORS) {
        // ナイフ兵: 露出した腕（袖まくり上部 = 肌色）+ 長い赤バンダナのしっぽ
        if (this.subType === 'knife') {
            const muscleGeo = new THREE.BoxGeometry(0.17, 0.22, 0.17);
            const muscleMat = new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.8 });
            for (let z of [-0.38, 0.38]) {
                const muscle = new THREE.Mesh(muscleGeo, muscleMat);
                muscle.position.set(0, 0.72, z);
                this.group.add(muscle);
            }
            // バンダナのしっぽ（後方にたなびく）
            const tailGeo = new THREE.BoxGeometry(0.03, 0.05, 0.5);
            const tailMat = new THREE.MeshStandardMaterial({ color: COLORS.redBandana, roughness: 0.8 });
            for (let z of [-0.05, 0.05]) {
                const tail = new THREE.Mesh(tailGeo, tailMat);
                tail.position.set(-0.35, 1.4, z);
                tail.rotation.y = z > 0 ? -0.25 : 0.25;
                this.group.add(tail);
            }
        }

        // 手榴弾兵: 胸の弾帯（手榴弾を縦に6個）
        if (this.subType === 'grenade') {
            const bandolierGeo = new THREE.BoxGeometry(0.52, 0.08, 0.12);
            const bandolierMat = new THREE.MeshStandardMaterial({ color: 0x5B3B1B, roughness: 0.85 });
            const bandolier = new THREE.Mesh(bandolierGeo, bandolierMat);
            bandolier.position.set(0.02, 0.95, 0);
            bandolier.rotation.x = 0.3;
            this.group.add(bandolier);
            const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3B5B2B, roughness: 0.6 });
            const grenadeGeo = new THREE.SphereGeometry(0.06, 6, 5);
            for (let i = 0; i < 6; i++) {
                const g = new THREE.Mesh(grenadeGeo, grenadeMat);
                const t = (i / 5 - 0.5) * 0.5;
                g.position.set(0.02 + Math.sin(t) * 0.26, 0.95 + Math.cos(t) * 0.26, (i - 2.5) * 0.08);
                this.group.add(g);
            }
        }

        // 機関銃兵: 肩から首にかけた弾薬ベルト + 胸のドラムマガジン
        if (this.subType === 'machinegun') {
            // 弾薬ベルト（斜め掛け）
            const beltGeo = new THREE.TorusGeometry(0.38, 0.045, 6, 20, Math.PI * 1.1);
            const beltMat = new THREE.MeshStandardMaterial({ color: 0xB8A56A, metalness: 0.5, roughness: 0.4 });
            const bullets = new THREE.Mesh(beltGeo, beltMat);
            bullets.position.set(0, 1.0, 0);
            bullets.rotation.z = 0.5;
            bullets.scale.set(0.95, 1.1, 0.6);
            this.group.add(bullets);
            // 弾丸ディテール（金色の粒）
            const bulletGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.05, 5);
            for (let i = 0; i < 12; i++) {
                const a = i / 11 * Math.PI * 1.1 - 0.3;
                const b = new THREE.Mesh(bulletGeo, beltMat);
                const rx = Math.cos(a + 0.5) * 0.38;
                const ry = Math.sin(a + 0.5) * 0.38;
                b.position.set(rx * 0.95, 1.0 + ry * 1.1, 0);
                b.rotation.z = a;
                this.group.add(b);
            }
            // 太いベスト（ガタイ強調）
            const bulkGeo = new THREE.BoxGeometry(0.55, 0.25, 0.7);
            const bulkMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.85 });
            const bulk = new THREE.Mesh(bulkGeo, bulkMat);
            bulk.position.y = 0.75;
            this.group.add(bulk);
        }

        // 士官: 肩章 + 長いトレンチコート + 赤ベレー星章
        if (this.subType === 'officer') {
            // 肩章
            const epauletGeo = new THREE.BoxGeometry(0.18, 0.06, 0.12);
            const epauletMat = new THREE.MeshStandardMaterial({ color: 0xD4A832, metalness: 0.6, roughness: 0.3 });
            for (let z of [-0.35, 0.35]) {
                const e = new THREE.Mesh(epauletGeo, epauletMat);
                e.position.set(0, 1.1, z);
                this.group.add(e);
            }
            // ベレー星章
            const starGeo = new THREE.SphereGeometry(0.05, 6, 4);
            const starMat = new THREE.MeshStandardMaterial({ color: 0xFFCC22, metalness: 0.7, roughness: 0.2 });
            const star = new THREE.Mesh(starGeo, starMat);
            star.position.set(0.25, 1.52, 0);
            star.scale.set(1.2, 1.0, 0.5);
            this.group.add(star);
            // トレンチコートの裾（膝下）
            const coatGeo = new THREE.BoxGeometry(0.56, 0.35, 0.62);
            const coatMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.8 });
            const coat = new THREE.Mesh(coatGeo, coatMat);
            coat.position.y = 0.55;
            this.group.add(coat);
        }

        // シールド兵: 盾に赤い Rebel 星マーク
        if (this.subType === 'shield') {
            // 追加のチェストプレート
            const plateGeo = new THREE.BoxGeometry(0.54, 0.3, 0.6);
            const plateMat = new THREE.MeshStandardMaterial({ color: 0x3A4828, metalness: 0.3, roughness: 0.5 });
            const plate = new THREE.Mesh(plateGeo, plateMat);
            plate.position.y = 0.95;
            this.group.add(plate);
        }

        // ロケット兵: 背中のロケット予備
        if (this.subType === 'rocket') {
            const spareGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.3, 6);
            const spareMat = new THREE.MeshStandardMaterial({ color: 0x3350AA, roughness: 0.5 });
            for (let z of [-0.1, 0.1]) {
                const spare = new THREE.Mesh(spareGeo, spareMat);
                spare.position.set(-0.38, 1.2, z);
                this.group.add(spare);
                // 弾頭（赤）
                const warheadGeo = new THREE.ConeGeometry(0.06, 0.08, 5);
                const warheadMat = new THREE.MeshStandardMaterial({ color: 0xAA3322, roughness: 0.6 });
                const warhead = new THREE.Mesh(warheadGeo, warheadMat);
                warhead.position.set(-0.38, 1.39, z);
                this.group.add(warhead);
            }
        }
    }

    _buildWeapon(COLORS) {
        const weaponMat = new THREE.MeshStandardMaterial({
            color: COLORS.metal, roughness: 0.4, metalness: 0.5
        });

        if (this.subType === 'rifle') {
            // ライフル
            const gunBody = new THREE.BoxGeometry(0.08, 0.08, 0.9);
            const gun = new THREE.Mesh(gunBody, weaponMat);
            gun.position.set(0.3, 0.85, 0);
            gun.rotation.x = Math.PI / 2;
            this.group.add(gun);

            // ストック
            const stockGeo = new THREE.BoxGeometry(0.06, 0.06, 0.25);
            const stockMat = new THREE.MeshStandardMaterial({ color: 0x5B3B1B, roughness: 0.8 });
            const stock = new THREE.Mesh(stockGeo, stockMat);
            stock.position.set(0.3, 0.85, -0.55);
            stock.rotation.x = Math.PI / 2 + 0.2;
            this.group.add(stock);

        } else if (this.subType === 'knife') {
            // ナイフ（大きめ、光る刃）
            const bladeGeo = new THREE.BoxGeometry(0.04, 0.03, 0.4);
            const bladeMat = new THREE.MeshStandardMaterial({
                color: 0xCCCCCC, metalness: 0.8, roughness: 0.2
            });
            const blade = new THREE.Mesh(bladeGeo, bladeMat);
            blade.position.set(0.35, 0.9, 0.35);
            this.group.add(blade);

            const handleGeo = new THREE.BoxGeometry(0.05, 0.04, 0.15);
            const handleMat = new THREE.MeshStandardMaterial({ color: 0x3B2B1B, roughness: 0.8 });
            const handle = new THREE.Mesh(handleGeo, handleMat);
            handle.position.set(0.35, 0.9, 0.15);
            this.group.add(handle);

        } else if (this.subType === 'rocket') {
            // バズーカ（太く長く）
            const launcherGeo = new THREE.CylinderGeometry(0.14, 0.14, 1.0, 10);
            const launcher = new THREE.Mesh(launcherGeo, weaponMat);
            launcher.rotation.x = Math.PI / 2;
            launcher.position.set(0.18, 1.15, 0.35);
            this.group.add(launcher);
            // リブ（補強リング）
            const ribMat = new THREE.MeshStandardMaterial({ color: COLORS.darkGray, metalness: 0.5, roughness: 0.5 });
            for (const offz of [-0.2, 0.0, 0.2]) {
                const rib = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 6, 12), ribMat);
                rib.rotation.y = Math.PI / 2;
                rib.position.set(0.18, 1.15, 0.35 + offz);
                this.group.add(rib);
            }
            // 肩当てパッド
            const padGeo = new THREE.BoxGeometry(0.18, 0.12, 0.2);
            const padMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });
            const pad = new THREE.Mesh(padGeo, padMat);
            pad.position.set(0.18, 1.15, -0.12);
            this.group.add(pad);
            // グリップ（下）
            const gripGeo = new THREE.BoxGeometry(0.08, 0.18, 0.08);
            const grip = new THREE.Mesh(gripGeo, ribMat);
            grip.position.set(0.18, 0.98, 0.1);
            this.group.add(grip);
            // 前面開口部
            const openGeo = new THREE.RingGeometry(0.07, 0.14, 10);
            const openMat = new THREE.MeshBasicMaterial({ color: 0x0A0A0A, side: THREE.DoubleSide });
            const open = new THREE.Mesh(openGeo, openMat);
            open.position.set(0.18, 1.15, 0.86);
            this.group.add(open);

        } else if (this.subType === 'shield') {
            // 大型ラウンドシールド
            const shieldGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.08, 18);
            const shieldMat = new THREE.MeshStandardMaterial({
                color: COLORS.shield, roughness: 0.5, metalness: 0.4
            });
            this.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
            this.shieldMesh.rotation.z = Math.PI / 2;
            this.shieldMesh.position.set(0.4, 0.85, 0);
            this.shieldMesh.castShadow = true;
            this.group.add(this.shieldMesh);
            // Rebel 星章（赤）
            const insigniaGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.02, 5);
            const insigniaMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 0.5 });
            const insignia = new THREE.Mesh(insigniaGeo, insigniaMat);
            insignia.rotation.z = Math.PI / 2;
            insignia.position.set(0.45, 0.85, 0);
            this.group.add(insignia);

            // シールドの補強リベット
            const rivetGeo = new THREE.SphereGeometry(0.03, 4, 4);
            const rivetMat = new THREE.MeshStandardMaterial({ color: 0x3A3A3A, metalness: 0.6 });
            for (let y of [0.5, 0.9]) {
                for (let z of [-0.15, 0.15]) {
                    const rivet = new THREE.Mesh(rivetGeo, rivetMat);
                    rivet.position.set(0.4, y, z);
                    this.group.add(rivet);
                }
            }

            // 片手武器（棍棒）
            const clubGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.5, 6);
            const clubMat = new THREE.MeshStandardMaterial({ color: 0x5B3B1B, roughness: 0.8 });
            const club = new THREE.Mesh(clubGeo, clubMat);
            club.position.set(-0.1, 0.85, 0.3);
            club.rotation.x = 0.3;
            this.group.add(club);
        } else if (this.subType === 'machinegun') {
            // 重機関銃（太い + 銃身冷却ジャケット）
            const mgBody = new THREE.BoxGeometry(0.18, 0.18, 0.5);
            const mg = new THREE.Mesh(mgBody, weaponMat);
            mg.position.set(0.3, 0.85, 0);
            this.group.add(mg);
            // 冷却銃身（リブ付き）
            const barrelGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.75, 10);
            const barrel = new THREE.Mesh(barrelGeo, weaponMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0.3, 0.85, 0.55);
            this.group.add(barrel);
            const coolRibMat = new THREE.MeshStandardMaterial({ color: COLORS.darkGray, metalness: 0.5, roughness: 0.5 });
            for (const z of [0.3, 0.45, 0.6, 0.75]) {
                const rib = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.02, 6, 14), coolRibMat);
                rib.rotation.y = Math.PI / 2;
                rib.position.set(0.3, 0.85, z);
                this.group.add(rib);
            }
            // ドラム弾倉（丸いマガジン）
            const drumGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 12);
            const drum = new THREE.Mesh(drumGeo, weaponMat);
            drum.position.set(0.3, 0.7, 0);
            this.group.add(drum);
            // グリップ
            const gripGeo = new THREE.BoxGeometry(0.05, 0.15, 0.06);
            const gripMat = new THREE.MeshStandardMaterial({ color: 0x5B3B1B, roughness: 0.85 });
            const grip = new THREE.Mesh(gripGeo, gripMat);
            grip.position.set(0.3, 0.7, -0.2);
            this.group.add(grip);
        } else if (this.subType === 'officer') {
            // 拳銃を構える（上向き）
            const pistolBodyGeo = new THREE.BoxGeometry(0.07, 0.13, 0.18);
            const pistol = new THREE.Mesh(pistolBodyGeo, weaponMat);
            pistol.position.set(0.3, 1.1, 0.25);
            this.group.add(pistol);
            const pistolBarrelGeo = new THREE.BoxGeometry(0.05, 0.05, 0.18);
            const pBarrel = new THREE.Mesh(pistolBarrelGeo, weaponMat);
            pBarrel.position.set(0.3, 1.17, 0.4);
            this.group.add(pBarrel);
            // サーベル（腰に提げる）
            const saberGeo = new THREE.BoxGeometry(0.02, 0.02, 0.45);
            const saberMat = new THREE.MeshStandardMaterial({ color: 0xCCCCCC, metalness: 0.8, roughness: 0.2 });
            const saber = new THREE.Mesh(saberGeo, saberMat);
            saber.position.set(-0.1, 0.5, -0.3);
            saber.rotation.x = 0.6;
            this.group.add(saber);
        } else if (this.subType === 'grenade') {
            // 掲げた右手の手榴弾（投擲ポーズ）
            const grenGeo = new THREE.SphereGeometry(0.1, 8, 6);
            const grenMat = new THREE.MeshStandardMaterial({ color: 0x3B5B2B, roughness: 0.6 });
            const gren = new THREE.Mesh(grenGeo, grenMat);
            gren.position.set(0.05, 1.55, 0.38);
            this.group.add(gren);
            // ピン（黄色）
            const pinGeo = new THREE.TorusGeometry(0.03, 0.01, 5, 8);
            const pinMat = new THREE.MeshStandardMaterial({ color: 0xD4A832, metalness: 0.7 });
            const pin = new THREE.Mesh(pinGeo, pinMat);
            pin.position.set(0.05, 1.63, 0.38);
            this.group.add(pin);
            // 予備手榴弾を腰に
            const belt2 = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), grenMat);
            belt2.position.set(0.3, 0.7, 0.2);
            this.group.add(belt2);
        }
    }

    update(dt, playerPos, elapsedTime) {
        if (!this.alive) return;
        super.update(dt, playerPos, elapsedTime);

        this.timeSinceSpawn += dt;
        if (this.timeSinceSpawn < this.alertDelay) return; // 出現遅延

        // 初回: プレイヤー側に「射程を通る導線ターゲット」を設定。
        // スポーン位置と反対側の、プレイヤー付近を横切る点を目標にすることで、
        // 敵はプレイヤー戦車の射程（正面扇状）を必ず通過する。
        if (this.crossTargetX === null) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (4 + Math.random() * 5);
            const spawnAhead = this.group.position.z > playerPos.z;
            // 前方スポーンは後方へ、後方スポーンは前方へ通り抜ける
            this.crossTargetZ = playerPos.z + (spawnAhead ? -6 : 8) + (Math.random() - 0.5) * 3;
        }

        const toPlayer = new THREE.Vector3().subVectors(playerPos, this.group.position);
        toPlayer.y = 0;
        const dist = toPlayer.length();
        const dirToPlayer = toPlayer.clone().normalize();

        // 導線ターゲット方向（進行方向）
        const toCross = new THREE.Vector3(
            this.crossTargetX - this.group.position.x,
            0,
            this.crossTargetZ - this.group.position.z
        );
        const crossDist = toCross.length();
        const dirToCross = crossDist > 0.001 ? toCross.clone().normalize() : dirToPlayer.clone();

        // 体はプレイヤー方向を向く（砲口がプレイヤーを狙うため）
        const angle = Math.atan2(-dirToPlayer.z, dirToPlayer.x);
        this.group.rotation.y = angle;

        // AI が共通で参照する導線
        this._dirToCross = dirToCross;
        this._crossDist = crossDist;

        // --- AI ---
        switch (this.subType) {
            case 'rifle':
                this._aiRifle(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'knife':
                this._aiKnife(dt, dist, dirToPlayer, playerPos);
                break;
            case 'rocket':
                this._aiRocket(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'shield':
                this._aiShield(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'grenade':
                this._aiGrenade(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'machinegun':
                this._aiMachinegun(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'officer':
                this._aiOfficer(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
        }

        if (this.burstCount > 0) {
            this.burstTimer -= dt;
            if (this.burstTimer <= 0) {
                this._fireMachinegunProj(playerPos);
                this.burstTimer = 0.15; // rapid fire interval
                this.burstCount--;
            }
        }

        // 導線ターゲットに接近したら反対側に引き直す（射程内を往復する導線）
        if (this._crossDist !== undefined && this._crossDist < 2.0) {
            const side = this.group.position.x - playerPos.x;
            const crossSide = (side === 0 ? (Math.random() < 0.5 ? 1 : -1) : -Math.sign(side));
            this.crossTargetX = playerPos.x + crossSide * (5 + Math.random() * 5);
            this.crossTargetZ = playerPos.z + (Math.random() < 0.5 ? -6 : 8) + (Math.random() - 0.5) * 3;
        }

        // 歩行アニメーション（攻撃中でも横断移動するので常時アニメ）
        this.walkCycle += dt * (this.subType === 'knife' ? 18 : 10);
        const swing = Math.sin(this.walkCycle) * 0.4;
        this.leftLeg.rotation.x = swing;
        this.rightLeg.rotation.x = -swing;
    }

    // 射程を通る導線上を進みながら振る舞う共通ヘルパー。
    // dir は使わず this._dirToCross を利用して、敵は必ず横断移動する。
    _advanceCrossing(dt, speedScale = 1.0) {
        const d = this._dirToCross;
        if (!d) return;
        // 蛇行: 進行方向に直交する成分を sin で加えて動きに表情をつける
        this.weavePhase += dt * 2.5;
        const perp = new THREE.Vector3(-d.z, 0, d.x);
        const weave = Math.sin(this.weavePhase) * 0.35;
        const step = new THREE.Vector3(
            d.x + perp.x * weave,
            0,
            d.z + perp.z * weave
        ).multiplyScalar(this.speed * speedScale * dt);
        this.group.position.add(step);
    }

    _aiRifle(dt, dist, dir, playerPos, elapsed) {
        // 導線上を走りながら射撃。停止せず射程内を通過する。
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.6);
        if (dist <= this.attackRange) this._fire(playerPos, elapsed);
    }

    _aiKnife(dt, dist, dir, playerPos) {
        // 常に突進（プレイヤー直行）— 既に射程を通過する
        this.aiState = 'charge';
        this.group.position.add(dir.multiplyScalar(this.speed * dt));
    }

    _aiRocket(dt, dist, dir, playerPos, elapsed) {
        // 導線を移動しつつ、射程内でロケット発射。
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.5);
        if (dist <= this.attackRange && dist > 7) this._fireRocket(playerPos, elapsed);
    }

    _aiShield(dt, dist, dir, playerPos, elapsed) {
        // 盾を構えながら導線上を前進して射程を通過
        this.aiState = 'advance';
        this._advanceCrossing(dt, 0.85);
        if (dist <= this.attackRange) this._fire(playerPos, elapsed);
    }

    _fireRocket(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsed;

        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 1.1;

        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0.3; // わずかに上向き
        dir.normalize();

        const rocket = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 12,
            damage: this.damage,
            owner: 'enemy',
            type: 'rocket',
            maxDistance: 50,
        });
        this.projectiles.push(rocket);
    }

    _aiGrenade(dt, dist, dir, playerPos, elapsed) {
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.5);
        if (dist <= this.attackRange && dist > 6 && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireGrenade(playerPos);
        }
    }

    _aiMachinegun(dt, dist, dir, playerPos, elapsed) {
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.35);
        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate && this.burstCount === 0) {
            this.lastFireTime = elapsed;
            this.burstCount = 3;
        }
    }

    _aiOfficer(dt, dist, dir, playerPos, elapsed) {
        this.aiState = dist > this.attackRange * 0.7 ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange * 0.7 ? 1.0 : 0.7);
        if (dist <= this.attackRange * 0.7 && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireMachinegunProj(playerPos);
        }
    }

    _fireMachinegunProj(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.8;
        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();
        dir.x += (Math.random() - 0.5) * 0.05;
        dir.z += (Math.random() - 0.5) * 0.05;
        dir.normalize();

        const bullet = new Projectile(this.scene, {
            position: muzzlePos, direction: dir, speed: 20, damage: this.damage,
            owner: 'enemy', type: 'bullet', maxDistance: 60,
        });
        this.projectiles.push(bullet);
    }

    _fireGrenade(playerPos) {
        const startPos = this.group.position.clone();
        startPos.y += 1.0;

        const throwDir = new THREE.Vector3().subVectors(playerPos, startPos);
        throwDir.y = 0;
        const throwDist = throwDir.length();
        throwDir.normalize();

        const speed = Math.min(throwDist * 1.5, 25);
        const velocity = new THREE.Vector3(throwDir.x * speed, 8 + throwDist * 0.2, throwDir.z * speed);

        const grenadeMesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 6, 6),
            new THREE.MeshStandardMaterial({color: 0x3B5B2B})
        );
        grenadeMesh.position.copy(startPos);
        this.scene.add(grenadeMesh);

        const self = this;
        const grenadeProj = {
            mesh: grenadeMesh,
            previousPosition: startPos.clone(),
            velocity: velocity,
            age: 0,
            fuseTime: 1.5,
            alive: true,
            impactPending: false,
            impactPosition: startPos.clone(),
            damage: 20,
            hitRadius: 0.24,
            blastRadius: 3.0,
            explosionVisual: 'large',
            type: 'grenade',
            update(dt) {
                if (!this.alive || this.impactPending) return;
                this.age += dt;
                this.previousPosition.copy(this.mesh.position);
                this.velocity.y -= 25 * dt;
                this.mesh.position.addScaledVector(this.velocity, dt);
                if (this.mesh.position.y <= 0.1) {
                    this.mesh.position.y = 0.1;
                    this.velocity.y = Math.abs(this.velocity.y) * 0.25;
                    this.velocity.x *= 0.55;
                    this.velocity.z *= 0.55;
                }
                if (this.age >= this.fuseTime) {
                    this.alive = false;
                    this.impactPending = true;
                    this.impactPosition.copy(this.mesh.position);
                    self.scene.remove(this.mesh);
                }
            },
            destroy() {
                this.alive = false;
                this.impactPending = false;
                self.scene.remove(this.mesh);
                if (this.mesh.geometry) this.mesh.geometry.dispose();
                if (this.mesh.material) this.mesh.material.dispose();
            },
            getPosition() {
                return this.impactPending ? this.impactPosition.clone() : this.mesh.position.clone();
            }
        };
        this.projectiles.push(grenadeProj);
    }
}
