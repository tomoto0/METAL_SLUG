import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

// 歩兵モデルで毎回 new されていた定数引数のジオメトリを共有する。
// userData.shared=true を持つジオメトリは Enemy.destroy() で dispose しない。
// （subType ごとの色は materials 側で吸収されるので、ジオメトリは流用できる）
const _geoCache = new Map();
function _geo(key, factory) {
    let g = _geoCache.get(key);
    if (!g) {
        g = factory();
        g.userData.shared = true;
        _geoCache.set(key, g);
    }
    return g;
}

// 注意: Enemy.takeDamage は material.color を直接書き換えてフラッシュを掛けるため、
// material をインスタンス間で共有すると 1 体の被弾で全員が赤く点滅してしまう。
// よって Infantry では material は per-instance のままにし、geometry のみ共有する。

/**
 * 歩兵系の敵
 * subType: 'rifle' | 'knife' | 'rocket' | 'shield' | 'grenade' | 'machinegun'
 *        | 'officer' | 'flamethrower' | 'mummy' | 'sniper' | 'hunter' | 'ninja' | 'juggernaut'
 *        | 'commando' | 'demolition' | 'jetpack_raider'
 *
 * Metal Slug風: 巨大ヘルメット(頭=体の1/3)、ずんぐり体型
 */
export class Infantry extends Enemy {
    constructor(scene, {
        position,
        subType = 'rifle',
        lowShadow = false,
    }) {
        // Metal Slug 原作準拠チューニング
        // - 歩兵は基本 1HP 換算（バルカン 1〜2 発）で倒せるのが原則
        // - スコアは rebel army の典型値 (rifle 100 / knife 200 / grenade 200 /
        //   machinegun 400 / officer 600) に合わせる
        // - shield 兵は正面 45% ダメージ軽減があるため実質 HP 高め
        const SPECS = {
            rifle:       { hp: 8,  speed: 3.0, scoreValue: 100, fireRate: 1.5, damage: 5  },
            knife:       { hp: 6,  speed: 6.5, scoreValue: 200, fireRate: 99,  damage: 15 },
            rocket:      { hp: 10, speed: 2.5, scoreValue: 300, fireRate: 2.5, damage: 15 },
            shield:      { hp: 30, speed: 2.0, scoreValue: 400, fireRate: 2.0, damage: 10 },
            grenade:     { hp: 10, speed: 3.0, scoreValue: 200, fireRate: 2.5, damage: 20 },
            machinegun:  { hp: 20, speed: 2.2, scoreValue: 400, fireRate: 2.5, damage: 5  },
            officer:     { hp: 40, speed: 4.5, scoreValue: 600, fireRate: 1.2, damage: 10 },
            // --- 新兵種 ---
            flamethrower:{ hp: 25, speed: 2.4, scoreValue: 500, fireRate: 0.08, damage: 4 }, // 連続炎
            mummy:       { hp: 14, speed: 2.0, scoreValue: 300, fireRate: 99,   damage: 12 }, // 接近のみ
            sniper:      { hp: 6,  speed: 1.8, scoreValue: 400, fireRate: 3.5,  damage: 25 }, // 高威力低発射
            hunter:      { hp: 12, speed: 3.5, scoreValue: 250, fireRate: 1.8,  damage: 12 },
            ninja:       { hp: 12, speed: 7.5, scoreValue: 400, fireRate: 2.0,  damage: 10 }, // 手裏剣投擲
            juggernaut:  { hp: 90, speed: 2.6, scoreValue: 1000, fireRate: 1.6, damage: 24 }, // 後半重装エリート
            commando:    { hp: 34, speed: 5.4, scoreValue: 800, fireRate: 0.9,  damage: 9  }, // 終盤精鋭: 蛇行バースト
            demolition:  { hp: 46, speed: 3.1, scoreValue: 900, fireRate: 2.6,  damage: 22 }, // 終盤工兵: 面制圧
            jetpack_raider:{ hp: 18, speed: 6.2, scoreValue: 650, fireRate: 1.15, damage: 12 }, // 低空強襲兵
            perched_sniper: { hp: 22, speed: 0, scoreValue: 700, fireRate: 2.4, damage: 30 }, // 屋上スナイパー
        };
        const spec = SPECS[subType] || SPECS.rifle;

        super(scene, { position, ...spec, type: 'infantry' });
        this.subType = subType;
        // Wave 13+ では shadow caster を間引いて shadow pass コストを下げる。
        // 低 wave では原作風の影を維持して見栄えを優先。
        this._lowShadow = lowShadow;

        // AI状態
        this.aiState = 'advance';  // 'advance' | 'attack' | 'charge'
        // 兵種別射程
        const RANGES = {
            rocket: 25, knife: 2, mummy: 1.6,
            sniper: 38, hunter: 22, ninja: 14, flamethrower: 8, juggernaut: 11,
            commando: 18, demolition: 24,
            jetpack_raider: 22,
            perched_sniper: 65,
        };
        this.attackRange = RANGES[subType] !== undefined ? RANGES[subType] : 15;
        this.walkCycle = 0;
        this.alertDelay = 0.5 + Math.random() * 1.0; // 出現後の遅延
        this.timeSinceSpawn = 0;

        this.burstCount = 0;
        this.burstTimer = 0;
        this.specialTimer = Math.random() * 2.0;

        // 射程を通る導線（スポーン時は null、最初の update でプレイヤー側から決定）
        this.crossTargetX = null;
        this.crossTargetZ = null;
        this.weavePhase = Math.random() * Math.PI * 2;
        this.dynamicBits = [];
        this.leftLowerLeg = null;
        this.rightLowerLeg = null;
        this.leftBoot = null;
        this.rightBoot = null;
        this.leftArmMesh = null;
        this.rightArmMesh = null;
        this.leftHandMesh = null;
        this.rightHandMesh = null;

        // 屋上配置スナイパーは静止 / 高所固定
        this.perched = (subType === 'perched_sniper');
        this.airborne = (subType === 'jetpack_raider');
        this.perchY = 0;
        this.jetpackBaseHeight = 1.55 + Math.random() * 0.45;
        this.jetpackBoostTimer = 0;
        this.jetpackBombTimer = 0.4 + Math.random() * 1.2;
        this.jetpackBurstShots = 0;
        this.jetpackBurstTimer = 0;

        this._buildModel();
        if (this.perched) this._buildLaserSight();
        if (this.airborne) this.group.position.y = this.jetpackBaseHeight;
        this._recordMaterials();
        this.scene.add(this.group);
    }

    /**
     * 屋上スナイパー用のレーザー照準ビーム。
     * 起点はライフル銃口、ターゲットは update でプレイヤー方向に伸ばす。
     */
    _buildLaserSight() {
        const laserMat = new THREE.MeshBasicMaterial({
            color: 0xFF2233, transparent: true, opacity: 0.62,
        });
        // 高さ 1 の単位シリンダーを Z 方向に伸ばす（scale.z で長さ調整）
        const laser = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 5), laserMat);
        laser.geometry.translate(0, 0.5, 0); // 原点を端に寄せる
        laser.rotation.x = Math.PI / 2;
        laser.position.set(0.30, 0.95, 0.55);
        laser.visible = false;
        this.group.add(laser);
        this.laserSight = laser;
        // 銃口の赤い光点
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xFF4040 });
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), dotMat);
        dot.position.set(0.30, 0.95, 0.55);
        this.group.add(dot);
        this.laserDot = dot;
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
        } else if (this.subType === 'flamethrower') {
            // 火炎兵: 赤系の防火スーツ + ガスマスク
            COLORS.uniform = 0xA64628;
            COLORS.uniformDark = 0x6E2C18;
            COLORS.vest = 0x3a3a3a;
            COLORS.helmet = 0x2A2A2A;
        } else if (this.subType === 'mummy') {
            // ミイラ: 全体ベージュ包帯
            COLORS.uniform = 0xD8C998;
            COLORS.uniformDark = 0xA89568;
            COLORS.vest = 0xC4B488;
            COLORS.skin = 0xC4B488;
            COLORS.skinDark = 0x8a7950;
            COLORS.helmet = 0xC4B488;
            COLORS.helmetBand = 0xA89568;
            COLORS.boots = 0x6a5a35;
        } else if (this.subType === 'sniper') {
            // スナイパー: ベージュ ローブ + 円錐笠
            COLORS.uniform = 0xC8A86A;
            COLORS.uniformDark = 0x8a7848;
            COLORS.vest = 0x4a3828;
            COLORS.helmet = 0x9A7A40; // 笠の色（後で帽子で上書き）
        } else if (this.subType === 'perched_sniper') {
            // 屋上狙撃手: 黒寄りの暗色ギリースーツ風
            COLORS.uniform = 0x3a3826;
            COLORS.uniformDark = 0x22241a;
            COLORS.vest = 0x4d4936;
            COLORS.helmet = 0x1f2218;
            COLORS.helmetBand = 0x4a4632;
            COLORS.boots = 0x1a1812;
        } else if (this.subType === 'hunter') {
            // ハンター: 茶系 ジャケット + つば広帽子
            COLORS.uniform = 0x6E4828;
            COLORS.uniformDark = 0x4A2E18;
            COLORS.vest = 0xA08858;
            COLORS.helmet = 0x3A2818;
        } else if (this.subType === 'ninja') {
            // 忍者: 紫黒 + 赤鉢巻き
            COLORS.uniform = 0x2A2638;
            COLORS.uniformDark = 0x18162A;
            COLORS.vest = 0x4A2018;
            COLORS.helmet = 0x18162A;
            COLORS.skin = 0xE0B888;
        } else if (this.subType === 'juggernaut') {
            // ジャガーノート: 重装グレー + 赤いバイザー
            COLORS.uniform = 0x4B515A;
            COLORS.uniformDark = 0x30353D;
            COLORS.vest = 0x6C727A;
            COLORS.helmet = 0x2A2E35;
            COLORS.boots = 0x22272C;
        } else if (this.subType === 'commando') {
            // 終盤コマンド: 黒緑の軽装アーマー + 青いバイザー
            COLORS.uniform = 0x263A34;
            COLORS.uniformDark = 0x172622;
            COLORS.vest = 0x4F645A;
            COLORS.helmet = 0x161F1C;
            COLORS.helmetBand = 0x5A8C7A;
            COLORS.boots = 0x151A18;
        } else if (this.subType === 'demolition') {
            // 爆破工兵: 黄土色の防爆装備 + 赤警告マーキング
            COLORS.uniform = 0x8A6B35;
            COLORS.uniformDark = 0x5C4420;
            COLORS.vest = 0x34383A;
            COLORS.helmet = 0x4C4636;
            COLORS.helmetBand = 0xD2A53A;
            COLORS.boots = 0x2A2118;
        } else if (this.subType === 'jetpack_raider') {
            // ジェットパック強襲兵: 青緑装甲 + 橙の推進炎
            COLORS.uniform = 0x2F666A;
            COLORS.uniformDark = 0x1E3D42;
            COLORS.vest = 0x596B62;
            COLORS.helmet = 0x163034;
            COLORS.helmetBand = 0xD2A53A;
            COLORS.boots = 0x182024;
            COLORS.backpack = 0x394A48;
        }

        // ============================================
        // 脚（2本、太腿/脛/ブーツを階層化）
        // ============================================
        this.leftLeg = new THREE.Group();
        this.rightLeg = new THREE.Group();

        const thighGeo = _geo('inf_thigh_refined', () => new THREE.BoxGeometry(0.20, 0.32, 0.22));
        const shinGeo = _geo('inf_shin_refined', () => new THREE.BoxGeometry(0.17, 0.28, 0.20));
        const bootGeo = _geo('inf_boot_refined', () => new THREE.BoxGeometry(0.38, 0.22, 0.30));
        const gaitersGeo = _geo('inf_gaiters_refined', () => new THREE.BoxGeometry(0.20, 0.11, 0.23));
        const kneeGeo = _geo('inf_knee_pad', () => new THREE.BoxGeometry(0.20, 0.08, 0.22));

        const bootMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.9 });
        const gaitersMat = new THREE.MeshStandardMaterial({ color: 0x8B7B5B, roughness: 0.8 });
        const legMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.8 });
        const kneeMat = new THREE.MeshStandardMaterial({ color: COLORS.vest, roughness: 0.82 });
        const soleMat = new THREE.MeshStandardMaterial({ color: 0x1f1712, roughness: 0.95 });

        const buildLeg = (side) => {
            const hip = new THREE.Group();
            hip.position.set(0, 0.78, side * 0.17);

            const thigh = new THREE.Mesh(thighGeo, legMat);
            thigh.position.y = -0.14;
            hip.add(thigh);

            const knee = new THREE.Mesh(kneeGeo, kneeMat);
            knee.position.set(0.02, -0.31, 0);
            hip.add(knee);

            const lower = new THREE.Group();
            lower.position.y = -0.28;

            const shin = new THREE.Mesh(shinGeo, legMat);
            shin.position.y = -0.10;
            lower.add(shin);

            const gaiter = new THREE.Mesh(gaitersGeo, gaitersMat);
            gaiter.position.y = -0.21;
            lower.add(gaiter);

            const boot = new THREE.Mesh(bootGeo, bootMat);
            boot.position.set(0.07, -0.31, 0);
            if (!this._lowShadow) boot.castShadow = true;
            lower.add(boot);

            const sole = new THREE.Mesh(_geo('inf_boot_sole', () => new THREE.BoxGeometry(0.42, 0.045, 0.32)), soleMat);
            sole.position.set(0.08, -0.43, 0);
            lower.add(sole);

            hip.add(lower);
            this.group.add(hip);
            return { hip, lower, boot };
        };

        const leftBuilt = buildLeg(-1);
        const rightBuilt = buildLeg(1);
        this.leftLeg = leftBuilt.hip;
        this.rightLeg = rightBuilt.hip;
        this.leftLowerLeg = leftBuilt.lower;
        this.rightLowerLeg = rightBuilt.lower;
        this.leftBoot = leftBuilt.boot;
        this.rightBoot = rightBuilt.boot;

        // ============================================
        // 胴体（ずんぐり、厚みのある）— ジオメトリは共有、material は per-instance
        // ============================================
        const torsoGeo = _geo('inf_torso', () => new THREE.BoxGeometry(0.5, 0.5, 0.55));
        const torsoMat = new THREE.MeshStandardMaterial({ color: COLORS.uniform, roughness: 0.8 });
        const torso = new THREE.Mesh(torsoGeo, torsoMat);
        torso.position.y = 0.95;
        // Wave 13+ は helmet 影のみで読み取れるため torso 影を省略する。
        if (!this._lowShadow) torso.castShadow = true;
        this.group.add(torso);

        // ベスト/装備ハーネス（スプライトシートの特徴）
        const vestGeo = _geo('inf_vest', () => new THREE.BoxGeometry(0.52, 0.35, 0.57));
        const vestMat = new THREE.MeshStandardMaterial({ color: COLORS.vest, roughness: 0.85 });
        const vest = new THREE.Mesh(vestGeo, vestMat);
        vest.position.y = 0.88;
        this.group.add(vest);

        // ベルト（太め）
        const beltGeo = _geo('inf_belt', () => new THREE.BoxGeometry(0.54, 0.08, 0.58));
        const beltMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.7 });
        const belt = new THREE.Mesh(beltGeo, beltMat);
        belt.position.y = 0.72;
        this.group.add(belt);

        // ベルトバックル
        const buckleGeo = _geo('inf_buckle', () => new THREE.BoxGeometry(0.1, 0.06, 0.1));
        const buckleMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, metalness: 0.6, roughness: 0.3 });
        const buckle = new THREE.Mesh(buckleGeo, buckleMat);
        buckle.position.set(0.28, 0.72, 0);
        this.group.add(buckle);

        // ============================================
        // 腕（太め、袖まくり）
        // ============================================
        const armGeo = _geo('inf_arm', () => new THREE.BoxGeometry(0.16, 0.38, 0.16));
        const armMat = new THREE.MeshStandardMaterial({ color: COLORS.uniform, roughness: 0.8 });
        const leftArm = new THREE.Mesh(armGeo, armMat);
        leftArm.position.set(0, 0.9, -0.38);
        this.group.add(leftArm);
        this.leftArmMesh = leftArm;

        const rightArm = new THREE.Mesh(armGeo, armMat);
        rightArm.position.set(0, 0.9, 0.38);
        this.group.add(rightArm);
        this.rightArmMesh = rightArm;

        // 手（肌色）
        const handGeo = _geo('inf_hand', () => new THREE.SphereGeometry(0.06, 6, 4));
        const handMat = new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.8 });
        const leftHand = new THREE.Mesh(handGeo, handMat);
        leftHand.position.set(0, 0.72, -0.38);
        this.group.add(leftHand);
        this.leftHandMesh = leftHand;
        const rightHand = new THREE.Mesh(handGeo, handMat);
        rightHand.position.set(0, 0.72, 0.38);
        this.group.add(rightHand);
        this.rightHandMesh = rightHand;

        // ============================================
        // 頭（巨大 = 体の約 40%、Metal Slug チビ体型）
        // ============================================
        const headGeo = _geo('inf_head', () => new THREE.SphereGeometry(0.38, 14, 12));
        const headMat = new THREE.MeshStandardMaterial({ color: COLORS.skin, roughness: 0.75 });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.y = 1.42;
        head.scale.set(1.05, 1.0, 0.95);
        if (!this._lowShadow) head.castShadow = true;
        this.group.add(head);
        this.headMesh = head;

        // 顎の影（下半分のソフトシャドウ）
        const chinGeo = _geo('inf_chin', () => new THREE.SphereGeometry(0.28, 10, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.3));
        const chinMat = new THREE.MeshStandardMaterial({ color: COLORS.skinDark, roughness: 0.85 });
        const chin = new THREE.Mesh(chinGeo, chinMat);
        chin.position.y = 1.34;
        chin.scale.set(1.0, 0.9, 0.88);
        this.group.add(chin);

        // 耳（小さく両側）
        const earGeo = _geo('inf_ear', () => new THREE.SphereGeometry(0.05, 6, 5));
        for (let z of [-0.34, 0.34]) {
            const ear = new THREE.Mesh(earGeo, headMat);
            ear.position.set(0.05, 1.4, z);
            ear.scale.set(0.7, 1.2, 0.5);
            this.group.add(ear);
        }

        // ヘルメット類は兵種ごとに置き換え（sniper/hunter/mummy/ninja は別装備）
        const wearsHelmet = !['sniper', 'hunter', 'mummy', 'ninja'].includes(this.subType);
        if (!wearsHelmet) {
            this.helmetMesh = null;
        }
        // ============================================
        // ヘルメット（さらに巨大なシュタールヘルム、深めのドーム）
        // ============================================
        if (wearsHelmet) {
        const helmetGeo = _geo('inf_helmet', () => new THREE.SphereGeometry(0.46, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62));
        const helmetMat = new THREE.MeshStandardMaterial({
            color: COLORS.helmet, roughness: 0.55, metalness: 0.25
        });
        const helmet = new THREE.Mesh(helmetGeo, helmetMat);
        helmet.position.y = 1.50;
        helmet.scale.set(1.12, 0.95, 1.1);
        helmet.castShadow = true;
        this.group.add(helmet);
        this.helmetMesh = helmet;

        // ヘルメットのトップハイライト（艶）— ジオメトリ・色とも固定
        const helmShineGeo = _geo('inf_helm_shine', () => new THREE.SphereGeometry(0.47, 14, 10, Math.PI * 0.2, Math.PI * 0.5, Math.PI * 0.05, Math.PI * 0.25));
        const helmShine = new THREE.Mesh(helmShineGeo, new THREE.MeshStandardMaterial({
            color: 0xFFFFFF, transparent: true, opacity: 0.18,
            roughness: 0.2, metalness: 0.3,
        }));
        helmShine.position.y = 1.50;
        helmShine.scale.set(1.1, 0.95, 1.1);
        this.group.add(helmShine);

        // ヘルメットの前ひさし（大きく前へ突き出る）
        const brimGeo = _geo('inf_brim', () => new THREE.CylinderGeometry(0.5, 0.52, 0.08, 18, 1, false, 0, Math.PI));
        const brimMat = new THREE.MeshStandardMaterial({ color: COLORS.helmet, roughness: 0.55, metalness: 0.2 });
        const brim = new THREE.Mesh(brimGeo, brimMat);
        brim.position.set(0.18, 1.34, 0);
        brim.rotation.z = Math.PI / 2;
        brim.rotation.y = -Math.PI / 2;
        this.group.add(brim);

        // ヘルメットの後部リップ
        const rearLipGeo = _geo('inf_rearlip', () => new THREE.CylinderGeometry(0.48, 0.5, 0.06, 14, 1, false, 0, Math.PI));
        const rearLip = new THREE.Mesh(rearLipGeo, brimMat);
        rearLip.position.set(-0.18, 1.36, 0);
        rearLip.rotation.z = Math.PI / 2;
        rearLip.rotation.y = Math.PI / 2;
        this.group.add(rearLip);

        // ヘルメットバンド（スプライトシートの特徴、太く）
        if (this.subType !== 'officer') {
            const bandGeo = _geo('inf_helm_band', () => new THREE.TorusGeometry(0.42, 0.028, 8, 20));
            const bandMat = new THREE.MeshStandardMaterial({ color: COLORS.helmetBand, roughness: 0.75 });
            const band = new THREE.Mesh(bandGeo, bandMat);
            band.position.y = 1.44;
            band.rotation.x = Math.PI / 2;
            band.scale.set(1.05, 1.0, 0.62);
            this.group.add(band);

            // バンドのバックル（小さな金属片）
            const bandBuckleGeo = _geo('inf_band_buckle', () => new THREE.BoxGeometry(0.06, 0.04, 0.05));
            const buckleMat = new THREE.MeshStandardMaterial({ color: 0x6B6155, metalness: 0.6, roughness: 0.4 });
            const bandBuckle = new THREE.Mesh(bandBuckleGeo, buckleMat);
            bandBuckle.position.set(0.4, 1.44, 0.18);
            this.group.add(bandBuckle);
        }

        // チンストラップ（あご紐、両側からあごへ）
        const chinStrapMat = new THREE.MeshStandardMaterial({
            color: 0x3a2a18, roughness: 0.85
        });
        const chinStrapGeo = _geo('inf_chinstrap', () => new THREE.BoxGeometry(0.018, 0.34, 0.022));
        for (let side of [-1, 1]) {
            const strap = new THREE.Mesh(chinStrapGeo, chinStrapMat);
            strap.position.set(0.10, 1.30, side * 0.36);
            strap.rotation.z = side * 0.05;
            strap.rotation.x = side * 0.18;
            this.group.add(strap);
        }
        // あご紐のバックル（中央）
        const chinBuckleGeo = _geo('inf_chin_buckle', () => new THREE.BoxGeometry(0.026, 0.04, 0.10));
        const chinBuckle = new THREE.Mesh(chinBuckleGeo,
            new THREE.MeshStandardMaterial({ color: 0x95956E, metalness: 0.6, roughness: 0.4 })
        );
        chinBuckle.position.set(0.18, 1.16, 0);
        this.group.add(chinBuckle);

        // ヘルメットネット用のロウなディテール（小さなリベット）
        const rivetMat = new THREE.MeshStandardMaterial({
            color: 0x3a3424, metalness: 0.5, roughness: 0.55
        });
        const rivetGeo = _geo('inf_rivet', () => new THREE.SphereGeometry(0.018, 5, 4));
        for (let z of [-0.34, 0.34]) {
            const rivet = new THREE.Mesh(rivetGeo, rivetMat);
            rivet.position.set(0.05, 1.46, z);
            this.group.add(rivet);
        }
        } // end wearsHelmet

        // 目・鼻・口・眉は通常顔の兵種のみ。覆面・包帯・ガスマスクの兵種はスキップ
        const hasOpenFace = !['mummy', 'ninja', 'flamethrower', 'shield'].includes(this.subType);
        if (hasOpenFace) {
        // 目（白目+黒目、Metal Slug 風の大きな目）— ジオメトリは共有
        const scleraGeo = _geo('inf_sclera', () => new THREE.SphereGeometry(0.075, 8, 6));
        const scleraMat = new THREE.MeshBasicMaterial({ color: 0xF8F4E8 });
        const pupilGeo = _geo('inf_pupil', () => new THREE.SphereGeometry(0.045, 6, 4));
        const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
        // 怒り・殺気の表情: サブタイプごとに瞳位置をわずかに変える
        const gazeZ = this.subType === 'knife' ? 0.030 : (this.subType === 'officer' ? 0.018 : 0.012);
        for (let z of [-0.14, 0.14]) {
            const sclera = new THREE.Mesh(scleraGeo, scleraMat);
            sclera.position.set(0.30, 1.40, z);
            sclera.scale.set(0.7, 1.0, 1.0);
            this.group.add(sclera);
            const pupil = new THREE.Mesh(pupilGeo, pupilMat);
            pupil.position.set(0.34, 1.40, z + (z > 0 ? -gazeZ : gazeZ));
            pupil.scale.set(0.6, 1.0, 1.0);
            this.group.add(pupil);
        }

        // 眉（怒り眉、太め）
        const browGeo = new THREE.BoxGeometry(0.025, 0.032, 0.13);
        const browMat = new THREE.MeshBasicMaterial({ color: 0x1a1208 });
        const isAngry = ['knife', 'officer', 'machinegun', 'rocket', 'grenade', 'commando', 'demolition'].includes(this.subType);
        for (let side of [-1, 1]) {
            const brow = new THREE.Mesh(browGeo, browMat);
            brow.position.set(0.34, 1.49, side * 0.14);
            brow.rotation.x = isAngry ? side * -0.55 : side * -0.1;
            this.group.add(brow);
        }

        // 鼻（団子っぽく出っ張り、Metal Slug 顔）
        const noseGeo = new THREE.SphereGeometry(0.06, 7, 5);
        const noseMat = new THREE.MeshStandardMaterial({ color: COLORS.skinDark, roughness: 0.82 });
        const nose = new THREE.Mesh(noseGeo, noseMat);
        nose.position.set(0.39, 1.34, 0);
        nose.scale.set(0.85, 0.95, 0.7);
        this.group.add(nose);

        // 口（サブタイプで形状違い）
        const yellingTypes = ['knife', 'machinegun', 'rocket', 'grenade', 'demolition'];
        if (yellingTypes.includes(this.subType)) {
            // 叫び口（黒い開口）
            const mouthOpenGeo = new THREE.BoxGeometry(0.025, 0.10, 0.14);
            const mouthOpenMat = new THREE.MeshBasicMaterial({ color: 0x180404 });
            const mouthOpen = new THREE.Mesh(mouthOpenGeo, mouthOpenMat);
            mouthOpen.position.set(0.36, 1.22, 0);
            this.group.add(mouthOpen);
            // 歯
            const teethGeo = new THREE.BoxGeometry(0.012, 0.022, 0.13);
            const teethMat = new THREE.MeshBasicMaterial({ color: 0xF0E8D0 });
            const teeth = new THREE.Mesh(teethGeo, teethMat);
            teeth.position.set(0.37, 1.245, 0);
            this.group.add(teeth);
        } else {
            const mouthGeo = new THREE.BoxGeometry(0.012, 0.022, 0.12);
            const mouthMat = new THREE.MeshBasicMaterial({ color: 0x3a2020 });
            const mouth = new THREE.Mesh(mouthGeo, mouthMat);
            mouth.position.set(0.36, 1.24, 0);
            this.group.add(mouth);
        }
        } // end hasOpenFace

        // 士官のヒゲ（太い口ひげ）
        if (this.subType === 'officer') {
            const moustacheGeo = new THREE.BoxGeometry(0.022, 0.04, 0.22);
            const moustacheMat = new THREE.MeshBasicMaterial({ color: 0x1a1208 });
            const moustache = new THREE.Mesh(moustacheGeo, moustacheMat);
            moustache.position.set(0.38, 1.26, 0);
            this.group.add(moustache);
            // 顎ひげ（短いやぎひげ）
            const goatee = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), moustacheMat);
            goatee.position.set(0.36, 1.16, 0);
            goatee.scale.set(0.7, 0.9, 0.6);
            this.group.add(goatee);
        }

        // ナイフ兵: 顔の傷跡（縦の赤い線）
        if (this.subType === 'knife') {
            const scarGeo = new THREE.BoxGeometry(0.014, 0.10, 0.005);
            const scarMat = new THREE.MeshBasicMaterial({ color: 0x8B2A1A });
            const scar = new THREE.Mesh(scarGeo, scarMat);
            scar.position.set(0.345, 1.32, 0.18);
            scar.rotation.z = -0.15;
            this.group.add(scar);
        }

        // ============================================
        // バックパック（大きめ、スプライトシートの特徴）
        // ============================================
        if (this.subType === 'rifle') {
            // 標準バックパック + 寝袋ロール
            const packMat = new THREE.MeshStandardMaterial({ color: COLORS.backpack, roughness: 0.9 });
            const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.32), packMat);
            pack.position.set(-0.38, 0.9, 0);
            this.group.add(pack);
            // 上部に寝袋ロール（円柱）
            const roll = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8),
                new THREE.MeshStandardMaterial({ color: 0x6B5B3A, roughness: 0.95 })
            );
            roll.rotation.x = Math.PI / 2;
            roll.position.set(-0.38, 1.20, 0);
            this.group.add(roll);
            // ストラップ
            const strapMat = new THREE.MeshStandardMaterial({ color: COLORS.boots, roughness: 0.8 });
            for (let z of [-0.12, 0.12]) {
                const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.5, 0.04), strapMat);
                strap.position.set(-0.16, 0.95, z);
                this.group.add(strap);
            }
        } else if (this.subType === 'rocket') {
            // ロケット兵: 巨大な砲筒予備をクロス背負い
            const tubeMat = new THREE.MeshStandardMaterial({ color: 0x2C3E78, roughness: 0.5, metalness: 0.3 });
            for (let i = 0; i < 2; i++) {
                const tube = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.07, 0.07, 0.7, 10),
                    tubeMat
                );
                tube.position.set(-0.4 + i * 0.05, 1.05, (i - 0.5) * 0.18);
                tube.rotation.z = (i === 0 ? -0.4 : 0.4);
                tube.rotation.x = 0.15;
                this.group.add(tube);
                // 弾頭（赤）
                const head = new THREE.Mesh(
                    new THREE.ConeGeometry(0.07, 0.12, 8),
                    new THREE.MeshStandardMaterial({ color: 0xAA3322, roughness: 0.6 })
                );
                head.position.copy(tube.position);
                head.position.y += 0.4 * Math.cos(tube.rotation.z);
                head.position.z += 0.4 * Math.sin(tube.rotation.z) * 0.3;
                head.rotation.copy(tube.rotation);
                this.group.add(head);
            }
        } else if (this.subType === 'grenade') {
            // 手榴弾兵: 4 個の手榴弾が並ぶフレーム
            const frameMat = new THREE.MeshStandardMaterial({ color: 0x6B5B3A, roughness: 0.9 });
            const frame = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.28), frameMat);
            frame.position.set(-0.38, 0.92, 0);
            this.group.add(frame);
            const grenadeMat = new THREE.MeshStandardMaterial({ color: 0x3B5B2B, roughness: 0.6 });
            for (let r = 0; r < 2; r++) {
                for (let c = 0; c < 2; c++) {
                    const g = new THREE.Mesh(new THREE.SphereGeometry(0.06, 7, 5), grenadeMat);
                    g.position.set(-0.5, 0.78 + r * 0.16, -0.08 + c * 0.16);
                    this.group.add(g);
                }
            }
        } else if (this.subType === 'machinegun') {
            // 機銃兵: 巨大な弾薬箱
            const boxMat = new THREE.MeshStandardMaterial({ color: 0x4A4A3A, roughness: 0.85 });
            const box = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.45, 0.36), boxMat);
            box.position.set(-0.42, 0.92, 0);
            this.group.add(box);
            // 取っ手（金属）
            const handle = new THREE.Mesh(
                new THREE.TorusGeometry(0.08, 0.012, 6, 12, Math.PI),
                new THREE.MeshStandardMaterial({ color: 0x6B6155, metalness: 0.6, roughness: 0.4 })
            );
            handle.position.set(-0.42, 1.18, 0);
            handle.rotation.x = Math.PI / 2;
            this.group.add(handle);
        } else if (this.subType === 'shield') {
            // シールド兵: 厚い装備パック
            const packMat = new THREE.MeshStandardMaterial({ color: 0x3F4828, roughness: 0.85, metalness: 0.2 });
            const pack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.42, 0.34), packMat);
            pack.position.set(-0.38, 0.9, 0);
            this.group.add(pack);
        } else if (this.subType === 'knife') {
            // ナイフ兵: 小型ポーチのみ（軽装）
            const smallPackMat = new THREE.MeshStandardMaterial({ color: COLORS.darkGray, roughness: 0.9 });
            const smallPack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.28, 0.22), smallPackMat);
            smallPack.position.set(-0.32, 0.85, 0);
            this.group.add(smallPack);
            // 腰のシース（鞘）
            const sheathMat = new THREE.MeshStandardMaterial({ color: 0x3B2B1B, roughness: 0.85 });
            const sheath = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.05), sheathMat);
            sheath.position.set(-0.05, 0.55, -0.32);
            sheath.rotation.x = 0.3;
            this.group.add(sheath);
        } else if (this.subType === 'officer') {
            // 士官は身軽。腰の地図ケースのみ
            const caseMat = new THREE.MeshStandardMaterial({ color: 0x5B4828, roughness: 0.7, metalness: 0.2 });
            const mapCase = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.22, 10), caseMat);
            mapCase.position.set(-0.05, 0.5, 0.30);
            mapCase.rotation.x = 0.4;
            this.group.add(mapCase);
        } else if (this.subType === 'juggernaut') {
            // 重装歩兵: 背中のパワーユニット
            const packMat = new THREE.MeshStandardMaterial({ color: 0x2E333A, roughness: 0.7, metalness: 0.35 });
            const pack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.58, 0.40), packMat);
            pack.position.set(-0.40, 0.98, 0);
            this.group.add(pack);
            const cellMat = new THREE.MeshStandardMaterial({ color: 0xAA2A22, roughness: 0.5, metalness: 0.45, emissive: 0x220808 });
            for (const z of [-0.14, 0.14]) {
                const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.46, 10), cellMat);
                cell.position.set(-0.56, 1.0, z);
                this.group.add(cell);
            }
        } else if (this.subType === 'commando') {
            // 終盤コマンド: 通信パック + 斜めの予備弾倉
            const packMat = new THREE.MeshStandardMaterial({ color: 0x1B2420, roughness: 0.68, metalness: 0.32 });
            const pack = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.48, 0.34), packMat);
            pack.position.set(-0.38, 0.96, 0);
            this.group.add(pack);
            const antennaMat = new THREE.MeshStandardMaterial({ color: 0x20282A, roughness: 0.45, metalness: 0.65 });
            for (const z of [-0.09, 0.09]) {
                const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 0.55, 5), antennaMat);
                antenna.position.set(-0.48, 1.35, z);
                antenna.rotation.z = -0.22;
                this.group.add(antenna);
            }
        } else if (this.subType === 'demolition') {
            // 爆破工兵: 爆薬フレームと大型起爆装置
            const frameMat = new THREE.MeshStandardMaterial({ color: 0x25292B, roughness: 0.62, metalness: 0.35 });
            const frame = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.38), frameMat);
            frame.position.set(-0.40, 0.98, 0);
            this.group.add(frame);
            const explosiveMat = new THREE.MeshStandardMaterial({ color: 0xA82018, roughness: 0.48, metalness: 0.22, emissive: 0x260604 });
            for (let i = 0; i < 4; i++) {
                const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.42, 7), explosiveMat);
                stick.position.set(-0.56, 0.78 + i * 0.13, (i % 2 ? 0.10 : -0.10));
                stick.rotation.x = Math.PI / 2;
                this.group.add(stick);
            }
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

        // 小物と可動アクセント。兵種の読み分けと動きの密度を上げる。
        this._buildDynamicAccents(COLORS);

        // 全体スケール調整（少し大きめにして当たり判定を改善）
        this.group.scale.setScalar(1.15);
    }

    _buildDynamicAccents(COLORS) {
        const strapMat = new THREE.MeshStandardMaterial({ color: 0x2a1b12, roughness: 0.92 });
        const metalMat = new THREE.MeshStandardMaterial({ color: COLORS.metalLight, roughness: 0.36, metalness: 0.62 });
        const stitchMat = new THREE.MeshBasicMaterial({ color: 0xf0d88a });

        // 肩ベルトと前面の留め具。小さな面の差で、遠目でも装備の密度が増える。
        for (const side of [-1, 1]) {
            const strap = new THREE.Mesh(_geo('inf_dynamic_chest_strap', () => new THREE.BoxGeometry(0.045, 0.46, 0.04)), strapMat);
            strap.position.set(0.285, 0.96, side * 0.22);
            strap.rotation.x = side * 0.34;
            this.group.add(strap);

            const buckle = new THREE.Mesh(_geo('inf_dynamic_buckle', () => new THREE.BoxGeometry(0.03, 0.055, 0.075)), metalMat);
            buckle.position.set(0.314, 0.84, side * 0.20);
            this.group.add(buckle);
        }

        // 腰ポーチ。シルエットを崩さずに兵士らしさを足す。
        for (const side of [-1, 1]) {
            const pouch = new THREE.Mesh(_geo('inf_dynamic_hip_pouch', () => new THREE.BoxGeometry(0.14, 0.16, 0.12)), new THREE.MeshStandardMaterial({
                color: COLORS.vest, roughness: 0.88,
            }));
            pouch.position.set(-0.04, 0.60, side * 0.35);
            pouch.rotation.x = side * 0.08;
            this.group.add(pouch);
        }

        // ブーツの明るいエッジ。接地位置が読み取りやすくなる。
        for (const boot of [this.leftBoot, this.rightBoot]) {
            if (!boot) continue;
            const stripe = new THREE.Mesh(_geo('inf_boot_edge_mark', () => new THREE.BoxGeometry(0.30, 0.018, 0.025)), stitchMat);
            stripe.position.set(0.06, 0.055, 0.14);
            boot.add(stripe);
        }

        // 風で揺れる短いストラップ。サブタイプの既存装備に干渉しない後方配置。
        const clothColor = this.subType === 'knife' || this.subType === 'ninja' ? COLORS.redBandana : COLORS.helmetBand;
        const clothMat = new THREE.MeshStandardMaterial({ color: clothColor, roughness: 0.86 });
        for (let i = 0; i < 2; i++) {
            const tail = new THREE.Mesh(_geo('inf_dynamic_cloth_tail', () => new THREE.BoxGeometry(0.035, 0.26, 0.05)), clothMat);
            tail.position.set(-0.36, 1.12 - i * 0.08, -0.11 + i * 0.22);
            tail.rotation.z = -0.18;
            this.group.add(tail);
            this.dynamicBits.push({
                mesh: tail,
                baseRotZ: tail.rotation.z,
                baseRotX: tail.rotation.x,
                phase: Math.random() * Math.PI * 2,
                amp: 0.08 + Math.random() * 0.06,
            });
        }

        if (this.subType === 'rocket' || this.subType === 'demolition' || this.subType === 'juggernaut') {
            const warningMat = new THREE.MeshBasicMaterial({ color: 0xffdd44 });
            for (const z of [-0.19, 0.19]) {
                const plate = new THREE.Mesh(_geo('inf_warning_tick', () => new THREE.BoxGeometry(0.018, 0.08, 0.08)), warningMat);
                plate.position.set(0.315, 1.08, z);
                this.group.add(plate);
            }
        }
    }

    _buildSubtypeGear(COLORS) {
        // ライフル兵: 階級章ストライプ（肩）+ 胸ポケット + 弾帯のチャージャー
        if (this.subType === 'rifle') {
            // 左肩の階級章ストライプ（V 字 2本）
            const stripeMat = new THREE.MeshStandardMaterial({ color: 0xCFAE54, roughness: 0.6 });
            for (let i = 0; i < 2; i++) {
                const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.12), stripeMat);
                stripe.position.set(0.0, 1.07 - i * 0.06, -0.39);
                stripe.rotation.x = 0.4;
                this.group.add(stripe);
            }
            // 胸ポケット（左右）
            const pocketMat = new THREE.MeshStandardMaterial({ color: COLORS.uniformDark, roughness: 0.85 });
            for (let z of [-0.22, 0.22]) {
                const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.16), pocketMat);
                pocket.position.set(0.26, 0.95, z);
                this.group.add(pocket);
                // ポケットボタン
                const button = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4),
                    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.5, roughness: 0.4 }));
                button.position.set(0.275, 0.88, z);
                this.group.add(button);
            }
            // 弾帯のチャージャー（クリップ x3）
            const clipMat = new THREE.MeshStandardMaterial({ color: 0xB0975C, metalness: 0.5, roughness: 0.4 });
            for (let i = 0; i < 3; i++) {
                const clip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 0.05), clipMat);
                clip.position.set(0.27, 0.78, -0.18 + i * 0.18);
                this.group.add(clip);
            }
            // 水筒（腰の左側）
            const canteenMat = new THREE.MeshStandardMaterial({ color: 0x3a4828, roughness: 0.85 });
            const canteen = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 10), canteenMat);
            canteen.position.set(-0.05, 0.55, 0.32);
            this.group.add(canteen);
        }

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
            // 二の腕の入れ墨（赤い帯）
            const tatMat = new THREE.MeshStandardMaterial({ color: 0x8B2A1A, roughness: 0.8 });
            for (let z of [-0.38, 0.38]) {
                const tat = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 5, 12), tatMat);
                tat.position.set(0, 0.78, z);
                tat.rotation.y = Math.PI / 2;
                this.group.add(tat);
            }
            // ナイフホルスター（脚）
            const holsterMat = new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.9 });
            const holster = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.08), holsterMat);
            holster.position.set(0.05, 0.4, -0.22);
            this.group.add(holster);
            // 弾薬ベルト（X 字斜め掛け、革）
            const xbeltMat = new THREE.MeshStandardMaterial({ color: 0x3a1a0a, roughness: 0.85 });
            for (let s of [-1, 1]) {
                const xbelt = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, 0.04), xbeltMat);
                xbelt.position.set(0.0, 0.95, 0);
                xbelt.rotation.z = s * 0.5;
                xbelt.rotation.x = s * 0.6;
                this.group.add(xbelt);
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

        // 手榴弾兵: 鉄兜のメッシュネット（カモフラージュ）+ 雑嚢
        if (this.subType === 'grenade') {
            // ヘルメットの偽装ネット（細い格子）
            const netMat = new THREE.MeshStandardMaterial({ color: 0x3b3a25, roughness: 0.95 });
            for (let i = 0; i < 4; i++) {
                const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42 - i * 0.05, 0.008, 5, 16), netMat);
                ring.position.y = 1.50 - i * 0.05;
                ring.rotation.x = Math.PI / 2;
                this.group.add(ring);
            }
            // ネットに刺した葉（カモ用）
            const leafMat = new THREE.MeshStandardMaterial({ color: 0x4a6b25, roughness: 0.9 });
            for (let i = 0; i < 5; i++) {
                const a = i / 4 * Math.PI - Math.PI / 2;
                const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.10, 0.04), leafMat);
                leaf.position.set(0.2 + Math.cos(a) * 0.25, 1.55, Math.sin(a) * 0.32);
                leaf.rotation.y = a;
                leaf.rotation.z = 0.4;
                this.group.add(leaf);
            }
            // 腰の雑嚢（ガスマスクポーチ）
            const pouchMat = new THREE.MeshStandardMaterial({ color: 0x5a4828, roughness: 0.9 });
            const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.14), pouchMat);
            pouch.position.set(0.05, 0.5, -0.32);
            this.group.add(pouch);
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
            // 胸の予備弾倉（4列）
            const magMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.6 });
            for (let i = 0; i < 4; i++) {
                const mag = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.15, 0.06), magMat);
                mag.position.set(0.27, 0.85, -0.18 + i * 0.12);
                this.group.add(mag);
            }
            // ヘルメットのバイザー（黒いゴーグル風）
            const visorMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.3, roughness: 0.4 });
            const visor = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.4), visorMat);
            visor.position.set(0.40, 1.42, 0);
            this.group.add(visor);
            // 葉巻（口の脇）
            const cigarMat = new THREE.MeshStandardMaterial({ color: 0x4a2818, roughness: 0.85 });
            const cigar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), cigarMat);
            cigar.position.set(0.38, 1.20, 0.08);
            cigar.rotation.z = Math.PI / 2;
            cigar.rotation.y = -0.3;
            this.group.add(cigar);
            // 葉巻の先（赤く光る）
            const emberMat = new THREE.MeshBasicMaterial({ color: 0xff5522 });
            const ember = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 4), emberMat);
            ember.position.set(0.44, 1.21, 0.10);
            this.group.add(ember);
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
            // 金ボタン（コート前面、4個縦並び）
            const goldMat = new THREE.MeshStandardMaterial({ color: 0xE2C24A, metalness: 0.7, roughness: 0.3 });
            for (let i = 0; i < 4; i++) {
                const btn = new THREE.Mesh(new THREE.SphereGeometry(0.024, 6, 5), goldMat);
                btn.position.set(0.27, 1.05 - i * 0.10, 0);
                btn.scale.set(0.6, 1, 1);
                this.group.add(btn);
            }
            // 胸の勲章リボン（左胸、3色帯）
            const ribbonColors = [0xCC2222, 0x2244BB, 0xCFAE54];
            for (let i = 0; i < 3; i++) {
                const r = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.04, 0.05),
                    new THREE.MeshStandardMaterial({ color: ribbonColors[i], roughness: 0.7 }));
                r.position.set(0.275, 1.0, 0.12 + i * 0.06);
                this.group.add(r);
            }
            // 赤いサッシュ（腰の斜め帯）
            const sashMat = new THREE.MeshStandardMaterial({ color: 0xAA2222, roughness: 0.75 });
            const sash = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.10, 0.62), sashMat);
            sash.position.y = 0.78;
            sash.rotation.z = -0.08;
            this.group.add(sash);
            // 黒い指揮グローブ（手を上書き）
            const gloveMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.85 });
            for (let z of [-0.38, 0.38]) {
                const glove = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 5), gloveMat);
                glove.position.set(0, 0.72, z);
                glove.scale.set(1, 0.9, 1);
                this.group.add(glove);
            }
        }

        // シールド兵: 盾に赤い Rebel 星マーク
        if (this.subType === 'shield') {
            // 追加のチェストプレート
            const plateGeo = new THREE.BoxGeometry(0.54, 0.3, 0.6);
            const plateMat = new THREE.MeshStandardMaterial({ color: 0x3A4828, metalness: 0.3, roughness: 0.5 });
            const plate = new THREE.Mesh(plateGeo, plateMat);
            plate.position.y = 0.95;
            this.group.add(plate);
            // 肩のスパイク（防御パッド、左右）
            const spikeMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.5, roughness: 0.5 });
            for (let z of [-0.36, 0.36]) {
                const pad = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.10, 0.20), spikeMat);
                pad.position.set(0, 1.16, z);
                this.group.add(pad);
                // スパイクの突起 x3
                for (let i = 0; i < 3; i++) {
                    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.08, 5), spikeMat);
                    sp.position.set(0, 1.25, z - 0.07 + i * 0.07);
                    this.group.add(sp);
                }
            }
            // 鉄仮面（顔下半分の覆面マスク）
            const maskMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.45 });
            const mask = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.45), maskMat);
            mask.position.set(0.05, 1.34, 0);
            mask.scale.set(1.1, 1.0, 1.05);
            this.group.add(mask);
            // マスクの呼吸スリット
            const slitMat = new THREE.MeshBasicMaterial({ color: 0x111111 });
            for (let i = 0; i < 3; i++) {
                const slit = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.015, 0.04), slitMat);
                slit.position.set(0.40, 1.20 + i * 0.025, -0.05 + i * 0.05);
                this.group.add(slit);
            }
        }

        // ジャガーノート: 装甲肩 + バイザー + 胸部プレート
        if (this.subType === 'juggernaut') {
            const armorMat = new THREE.MeshStandardMaterial({ color: 0x3C434C, roughness: 0.55, metalness: 0.35 });
            const visorMat = new THREE.MeshStandardMaterial({ color: 0xCC2A1A, roughness: 0.25, metalness: 0.45, emissive: 0x330A06 });

            const chest = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.40, 0.62), armorMat);
            chest.position.set(0.30, 1.0, 0);
            this.group.add(chest);

            for (const z of [-0.34, 0.34]) {
                const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.14, 0.24), armorMat);
                shoulder.position.set(0, 1.20, z);
                this.group.add(shoulder);
            }

            const visor = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.10, 0.26), visorMat);
            visor.position.set(0.39, 1.38, 0);
            this.group.add(visor);
        }

        // コマンド兵: フェイスバイザー + 軽量プレート + 腰回りの弾倉
        if (this.subType === 'commando') {
            const armorMat = new THREE.MeshStandardMaterial({ color: 0x26312E, roughness: 0.5, metalness: 0.45 });
            const visorMat = new THREE.MeshStandardMaterial({ color: 0x4AC8FF, roughness: 0.18, metalness: 0.5, emissive: 0x083448 });
            const visor = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.34), visorMat);
            visor.position.set(0.40, 1.41, 0);
            this.group.add(visor);

            const chest = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.36, 0.58), armorMat);
            chest.position.set(0.30, 0.98, 0);
            this.group.add(chest);

            const magMat = new THREE.MeshStandardMaterial({ color: 0x101414, roughness: 0.7, metalness: 0.35 });
            for (let i = 0; i < 5; i++) {
                const mag = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.15, 0.055), magMat);
                mag.position.set(0.28, 0.78, -0.24 + i * 0.12);
                mag.rotation.z = (i - 2) * 0.04;
                this.group.add(mag);
            }

            const kneeMat = new THREE.MeshStandardMaterial({ color: 0x101615, roughness: 0.55, metalness: 0.35 });
            for (const z of [-0.16, 0.16]) {
                const knee = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.20), kneeMat);
                knee.position.set(0.04, 0.48, z);
                this.group.add(knee);
            }
        }

        // 爆破工兵: 防爆襟、胸の起爆盤、警告色の肩パッド
        if (this.subType === 'demolition') {
            const blastMat = new THREE.MeshStandardMaterial({ color: 0x303335, roughness: 0.58, metalness: 0.42 });
            const warnMat = new THREE.MeshStandardMaterial({ color: 0xD2A53A, roughness: 0.72 });

            const collar = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.055, 6, 18, Math.PI * 1.15), blastMat);
            collar.position.set(0.04, 1.23, 0);
            collar.rotation.x = Math.PI / 2;
            collar.rotation.z = -0.2;
            this.group.add(collar);

            const detonator = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.30), blastMat);
            detonator.position.set(0.31, 1.0, 0);
            this.group.add(detonator);
            for (let i = 0; i < 3; i++) {
                const light = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), new THREE.MeshBasicMaterial({ color: i === 1 ? 0xFF3322 : 0x66FF88 }));
                light.position.set(0.34, 1.06 - i * 0.07, -0.07 + i * 0.07);
                this.group.add(light);
            }

            for (const z of [-0.36, 0.36]) {
                const pad = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.24), warnMat);
                pad.position.set(0, 1.18, z);
                this.group.add(pad);
            }
        }

        // ============================================
        // ジェットパック強襲兵: 双発パック + ゴーグル + 橙色排気炎
        // ============================================
        if (this.subType === 'jetpack_raider') {
            const packMat = new THREE.MeshStandardMaterial({ color: 0x2F4748, roughness: 0.45, metalness: 0.45 });
            const tankMat = new THREE.MeshStandardMaterial({ color: 0x5D6A62, roughness: 0.42, metalness: 0.55 });
            const nozzleMat = new THREE.MeshStandardMaterial({ color: 0x1A1C1E, roughness: 0.35, metalness: 0.75 });
            const flameMat = new THREE.MeshBasicMaterial({
                color: 0xFF8A22, transparent: true, opacity: 0.82,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
            });

            const pack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.62, 0.48), packMat);
            pack.position.set(-0.38, 1.02, 0);
            this.group.add(pack);

            for (const z of [-0.17, 0.17]) {
                const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.58, 10), tankMat);
                tank.position.set(-0.48, 1.04, z);
                this.group.add(tank);

                const capTop = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.035, 10), nozzleMat);
                capTop.position.set(-0.48, 1.36, z);
                this.group.add(capTop);

                const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.10, 0.16, 10), nozzleMat);
                nozzle.position.set(-0.48, 0.62, z);
                this.group.add(nozzle);

                const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 10, 1, true), flameMat.clone());
                flame.position.set(-0.48, 0.36, z);
                flame.rotation.z = Math.PI;
                this.group.add(flame);
                this.jetFlames = this.jetFlames || [];
                this.jetFlames.push(flame);
            }

            // ゴーグルと額バンド
            const visorMat = new THREE.MeshStandardMaterial({
                color: 0xA9F0FF, emissive: 0x144050, emissiveIntensity: 0.55,
                roughness: 0.18, metalness: 0.45,
            });
            const rimMat = new THREE.MeshStandardMaterial({ color: 0x111416, roughness: 0.42, metalness: 0.55 });
            for (const z of [-0.13, 0.13]) {
                const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.035, 12), visorMat);
                lens.position.set(0.38, 1.42, z);
                lens.rotation.z = Math.PI / 2;
                this.group.add(lens);
                const rim = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.012, 6, 14), rimMat);
                rim.position.set(0.40, 1.42, z);
                rim.rotation.y = Math.PI / 2;
                this.group.add(rim);
            }
            const strap = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.018, 6, 16), rimMat);
            strap.position.y = 1.43;
            strap.rotation.x = Math.PI / 2;
            strap.scale.set(1, 0.85, 1);
            this.group.add(strap);

            // 軽量ショルダーアーマー
            const padMat = new THREE.MeshStandardMaterial({ color: 0xD2A53A, roughness: 0.62, metalness: 0.25 });
            for (const z of [-0.36, 0.36]) {
                const pad = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.10, 0.22), padMat);
                pad.position.set(0.03, 1.18, z);
                pad.rotation.x = z > 0 ? 0.12 : -0.12;
                this.group.add(pad);
            }
        }

        // ロケット兵: 背中のロケット予備 + ゴーグル + 装甲胸当て
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
            // 赤いゴーグル（パイロット風）
            const goggleMat = new THREE.MeshStandardMaterial({ color: 0xCC3322, metalness: 0.4, roughness: 0.4 });
            for (let z of [-0.14, 0.14]) {
                const lens = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), goggleMat);
                lens.position.set(0.36, 1.42, z);
                lens.scale.set(0.5, 1, 1);
                this.group.add(lens);
            }
            // ゴーグルストラップ
            const strapMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.85 });
            const gStrap = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.018, 6, 16), strapMat);
            gStrap.position.set(0.0, 1.42, 0);
            gStrap.rotation.y = Math.PI / 2;
            gStrap.scale.set(1, 0.9, 1);
            this.group.add(gStrap);
            // 胸当て（金属プレート）
            const armorMat = new THREE.MeshStandardMaterial({ color: 0x3A4870, metalness: 0.4, roughness: 0.5 });
            const armor = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.32, 0.42), armorMat);
            armor.position.set(0.27, 0.95, 0);
            this.group.add(armor);
            // 装甲のリベット
            const rivetMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.6 });
            for (let y of [1.05, 0.85]) {
                for (let z of [-0.16, 0, 0.16]) {
                    const r = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4), rivetMat);
                    r.position.set(0.29, y, z);
                    this.group.add(r);
                }
            }
        }

        // ============================================
        // 火炎兵: ガスマスク + 燃料タンク + ホース
        // ============================================
        if (this.subType === 'flamethrower') {
            const maskMat = new THREE.MeshStandardMaterial({ color: 0x4a3018, metalness: 0.3, roughness: 0.55 });
            // マスクのフード（ヘルメット形状）
            const hood = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), maskMat);
            hood.position.y = 1.42;
            hood.scale.set(1.05, 1.05, 1.05);
            this.group.add(hood);
            // 円形の眼鏡レンズ（赤いガラス）
            const lensMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, metalness: 0.5, roughness: 0.3, emissive: 0x331100 });
            for (let z of [-0.15, 0.15]) {
                const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.04, 12), lensMat);
                lens.position.set(0.34, 1.42, z);
                lens.rotation.z = Math.PI / 2;
                this.group.add(lens);
                // レンズの金属枠
                const rim = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.012, 6, 14), maskMat);
                rim.position.set(0.36, 1.42, z);
                rim.rotation.y = Math.PI / 2;
                this.group.add(rim);
            }
            // フィルター（顎下の円筒）
            const filterMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.4, roughness: 0.55 });
            const filter = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.16, 10), filterMat);
            filter.position.set(0.36, 1.18, 0);
            filter.rotation.z = Math.PI / 2;
            this.group.add(filter);
            // 背中の燃料タンク 2基（赤いシリンダー）
            const tankMat = new THREE.MeshStandardMaterial({ color: 0x8B2A1A, roughness: 0.6, metalness: 0.3 });
            for (let z of [-0.14, 0.14]) {
                const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 10), tankMat);
                tank.position.set(-0.4, 1.0, z);
                this.group.add(tank);
                // タンクの上下キャップ
                const capMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.4 });
                for (let y of [0.7, 1.3]) {
                    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.04, 10), capMat);
                    cap.position.set(-0.4, y, z);
                    this.group.add(cap);
                }
                // 警告ストライプ（黄色）
                const stripeMat = new THREE.MeshStandardMaterial({ color: 0xE2C24A, roughness: 0.7 });
                const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.125, 0.018, 6, 14), stripeMat);
                stripe.position.set(-0.4, 1.05, z);
                stripe.rotation.x = Math.PI / 2;
                this.group.add(stripe);
            }
            // 燃料ホース（タンクから武器へ。簡略化: 短い円筒3つ）
            const hoseMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.85 });
            for (let i = 0; i < 3; i++) {
                const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.12, 6), hoseMat);
                seg.position.set(-0.1 + i * 0.12, 0.95 - i * 0.04, 0.30);
                seg.rotation.z = -0.6;
                this.group.add(seg);
            }
        }

        // ============================================
        // ミイラ: 全身に巻きつく包帯（リング） + たれた包帯のしっぽ
        // ============================================
        if (this.subType === 'mummy') {
            const wrapMat = new THREE.MeshStandardMaterial({ color: 0xC4B488, roughness: 0.95 });
            // 胴体に5本の横巻き包帯
            for (let i = 0; i < 5; i++) {
                const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.032, 6, 18), wrapMat);
                wrap.position.y = 0.78 + i * 0.10;
                wrap.rotation.x = Math.PI / 2;
                wrap.rotation.z = (i % 2) * 0.15;
                wrap.scale.set(1.0, 1.0, 0.85);
                this.group.add(wrap);
            }
            // 頭の巻き包帯（顔の右半分を残す)
            for (let i = 0; i < 3; i++) {
                const headWrap = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.026, 6, 16), wrapMat);
                headWrap.position.y = 1.30 + i * 0.10;
                headWrap.rotation.x = Math.PI / 2;
                headWrap.rotation.y = i * 0.2;
                headWrap.scale.set(0.9, 1.0, 0.95);
                this.group.add(headWrap);
            }
            // 腕の包帯（左右）
            for (let z of [-0.38, 0.38]) {
                for (let i = 0; i < 3; i++) {
                    const armWrap = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.018, 5, 12), wrapMat);
                    armWrap.position.set(0, 0.8 + i * 0.08, z);
                    armWrap.rotation.y = Math.PI / 2;
                    this.group.add(armWrap);
                }
            }
            // 垂れた包帯のしっぽ（後方に複数）
            for (let i = 0; i < 4; i++) {
                const tail = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 0.36, 0.06),
                    new THREE.MeshStandardMaterial({ color: 0xB0A078, roughness: 0.95 })
                );
                tail.position.set(-0.32 + (i % 2) * 0.05, 0.7, -0.15 + i * 0.10);
                tail.rotation.z = (i - 1.5) * 0.15;
                this.group.add(tail);
            }
            // 赤く光る目（怒り）
            const glowMat = new THREE.MeshBasicMaterial({ color: 0xFF2222 });
            for (let z of [-0.14, 0.14]) {
                const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), glowMat);
                eye.position.set(0.36, 1.40, z);
                this.group.add(eye);
            }
        }

        // ============================================
        // 屋上スナイパー: 暗色ギリーフード + ヘッドセット + 望遠スコープ照準器
        // ============================================
        if (this.subType === 'perched_sniper') {
            const hoodMat = new THREE.MeshStandardMaterial({ color: 0x2a2c1c, roughness: 0.95 });
            // フード（頭部を覆う）
            const hood = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 9, 0, Math.PI * 2, 0, Math.PI * 0.65), hoodMat);
            hood.position.y = 1.46;
            this.group.add(hood);
            // フードのドレープ（肩へ垂れる布）
            for (let s of [-1, 1]) {
                const drape = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.30, 0.42), hoodMat);
                drape.position.set(-0.06, 1.18, s * 0.30);
                drape.rotation.z = s * 0.18;
                this.group.add(drape);
            }
            // ギリー布の小片（ランダムな擬装ストリップ）
            const stripMat = new THREE.MeshStandardMaterial({ color: 0x4a4a30, roughness: 0.95 });
            for (let i = 0; i < 7; i++) {
                const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.05), stripMat);
                const ang = (i / 7) * Math.PI * 2;
                strip.position.set(Math.cos(ang) * 0.30, 1.20 + Math.random() * 0.25, Math.sin(ang) * 0.32);
                this.group.add(strip);
            }
            // ヘッドセット（黒いバンド + 耳カップ）
            const setMat = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.7 });
            const band = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.025, 5, 14), setMat);
            band.position.y = 1.55;
            band.rotation.x = Math.PI / 2;
            band.scale.set(1.0, 1.0, 0.85);
            this.group.add(band);
            for (let z of [-0.30, 0.30]) {
                const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 8), setMat);
                cup.position.set(0, 1.40, z);
                cup.rotation.x = Math.PI / 2;
                this.group.add(cup);
            }
            // 暗視ゴーグル / 単眼スコープ（赤いレンズ）
            const lensMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, emissive: 0x441100, metalness: 0.5, roughness: 0.3 });
            const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 10), lensMat);
            lens.rotation.z = Math.PI / 2;
            lens.position.set(0.36, 1.40, 0.10);
            this.group.add(lens);
        }

        // ============================================
        // スナイパー: 円錐笠 + 薄手のローブ + ストール
        // ============================================
        if (this.subType === 'sniper') {
            // 円錐笠（典型的なアジア風スナイパー帽）
            const hatMat = new THREE.MeshStandardMaterial({ color: 0xC8A86A, roughness: 0.85 });
            const hat = new THREE.Mesh(new THREE.ConeGeometry(0.55, 0.42, 16), hatMat);
            hat.position.y = 1.65;
            this.group.add(hat);
            // 笠の下端（リム）
            const hatRim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 6, 18), hatMat);
            hatRim.position.y = 1.45;
            hatRim.rotation.x = Math.PI / 2;
            this.group.add(hatRim);
            // 笠の編み目（同心円）
            const ringMat = new THREE.MeshStandardMaterial({ color: 0xA08850, roughness: 0.9 });
            for (let i = 1; i < 4; i++) {
                const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13 * i, 0.006, 4, 14), ringMat);
                ring.position.y = 1.65 - i * 0.10;
                ring.rotation.x = Math.PI / 2;
                this.group.add(ring);
            }
            // 顔の下半分の覆面（黒い布）
            const veilMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.95 });
            const veil = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.4), veilMat);
            veil.position.set(0.05, 1.34, 0);
            veil.scale.set(1.05, 1.0, 1.05);
            this.group.add(veil);
            // ローブの裾
            const robeMat = new THREE.MeshStandardMaterial({ color: 0xC8A86A, roughness: 0.85 });
            const robe = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.30, 0.62), robeMat);
            robe.position.y = 0.55;
            this.group.add(robe);
        }

        // ============================================
        // ハンター: つば広帽子（カウボーイ風） + ロング コート
        // ============================================
        if (this.subType === 'hunter') {
            const hatMat = new THREE.MeshStandardMaterial({ color: 0x3A2818, roughness: 0.85 });
            // 帽子のクラウン
            const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.28, 12), hatMat);
            crown.position.y = 1.62;
            this.group.add(crown);
            // 帽子のへこみ（トップ）
            const dent = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.04, 0.18), hatMat);
            dent.position.y = 1.74;
            this.group.add(dent);
            // つば（広い）
            const brimMat2 = new THREE.MeshStandardMaterial({ color: 0x2A1808, roughness: 0.85 });
            const brim2 = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.04, 18), brimMat2);
            brim2.position.y = 1.46;
            this.group.add(brim2);
            // 帽子バンド（赤帯）
            const bandMat = new THREE.MeshStandardMaterial({ color: 0xA63828, roughness: 0.7 });
            const band = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.022, 6, 16), bandMat);
            band.position.y = 1.50;
            band.rotation.x = Math.PI / 2;
            this.group.add(band);
            // 無精ヒゲ（顎の暗い斑点）
            const stubbleMat = new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.95 });
            const stubble = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.35), stubbleMat);
            stubble.position.set(0.05, 1.30, 0);
            stubble.scale.set(1.1, 0.7, 1.0);
            this.group.add(stubble);
            // ロングコート（茶色）
            const coatMat2 = new THREE.MeshStandardMaterial({ color: 0x4A2E18, roughness: 0.85 });
            const coat2 = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.40, 0.62), coatMat2);
            coat2.position.y = 0.5;
            this.group.add(coat2);
            // 弾帯（胸X字）
            const xbeltMat = new THREE.MeshStandardMaterial({ color: 0x2A1808, roughness: 0.85 });
            for (let s of [-1, 1]) {
                const xbelt = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.08), xbeltMat);
                xbelt.position.set(0.0, 0.95, 0);
                xbelt.rotation.z = s * 0.5;
                xbelt.rotation.x = s * 0.6;
                this.group.add(xbelt);
                // 弾丸（金色の粒）
                const shellMat = new THREE.MeshStandardMaterial({ color: 0xCFAE54, metalness: 0.6, roughness: 0.4 });
                for (let i = 0; i < 6; i++) {
                    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.05, 5), shellMat);
                    const t = (i / 5 - 0.5) * 0.5;
                    shell.position.set(Math.sin(t) * 0.27, 0.95 + Math.cos(t) * 0.27 * s, (i - 2.5) * 0.06);
                    shell.rotation.z = s * 0.5;
                    this.group.add(shell);
                }
            }
        }

        // ============================================
        // 忍者: 顔覆面 + 赤鉢巻き + 胸の鎖帷子（小） + 二の腕プロテクター
        // ============================================
        if (this.subType === 'ninja') {
            // 顔の覆面（黒い布）
            const maskMat = new THREE.MeshStandardMaterial({ color: 0x18162A, roughness: 0.9 });
            const mask = new THREE.Mesh(new THREE.SphereGeometry(0.40, 14, 10), maskMat);
            mask.position.y = 1.42;
            mask.scale.set(1.02, 1.02, 1.02);
            this.group.add(mask);
            // 目のスリット（白い細長い帯）
            const slitMat = new THREE.MeshBasicMaterial({ color: 0xF8F4E8 });
            for (let z of [-0.13, 0.13]) {
                const slit = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.045, 0.13), slitMat);
                slit.position.set(0.36, 1.42, z);
                this.group.add(slit);
            }
            // 瞳（赤く光る）
            const pupMat = new THREE.MeshBasicMaterial({ color: 0xCC2222 });
            for (let z of [-0.13, 0.13]) {
                const pup = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.04), pupMat);
                pup.position.set(0.39, 1.42, z);
                this.group.add(pup);
            }
            // 赤い鉢巻き（額）
            const headbandMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 0.75 });
            const headband = new THREE.Mesh(new THREE.TorusGeometry(0.41, 0.04, 6, 18), headbandMat);
            headband.position.y = 1.55;
            headband.rotation.x = Math.PI / 2;
            headband.scale.set(1.0, 1.0, 0.9);
            this.group.add(headband);
            // 鉢巻きのしっぽ（後方になびく）
            for (let z of [-0.07, 0.07]) {
                const tail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.06, 0.5), headbandMat);
                tail.position.set(-0.35, 1.55, z);
                tail.rotation.y = z > 0 ? -0.25 : 0.25;
                this.group.add(tail);
            }
            // 胸の鎖帷子（小さなリング x9）
            const chainMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.7, roughness: 0.4 });
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    const link = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.005, 4, 8), chainMat);
                    link.position.set(0.27, 1.05 - r * 0.07, -0.07 + c * 0.07);
                    link.rotation.y = Math.PI / 2;
                    this.group.add(link);
                }
            }
            // 二の腕プロテクター（黒い帯 + 銀色のプレート）
            for (let z of [-0.38, 0.38]) {
                const protMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6, roughness: 0.4 });
                const prot = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.10, 0.18), protMat);
                prot.position.set(0, 0.78, z);
                this.group.add(prot);
            }
            // 腰の手裏剣ホルダー（小さな星型はコストかかるのでDISCを並べる）
            const shurMat = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.7, roughness: 0.3 });
            for (let i = 0; i < 3; i++) {
                const star = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 6), shurMat);
                star.position.set(-0.05, 0.55 - i * 0.04, -0.32);
                star.rotation.x = Math.PI / 2;
                this.group.add(star);
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
        } else if (this.subType === 'flamethrower') {
            // 火炎放射器: 太いタンク + 細いノズル + パイロット火
            const flameMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.5, roughness: 0.5 });
            const ftBody = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.55), flameMat);
            ftBody.position.set(0.3, 0.95, 0.0);
            this.group.add(ftBody);
            // ノズル先端の細い管
            const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.5, 8), flameMat);
            nozzle.rotation.x = Math.PI / 2;
            nozzle.position.set(0.3, 0.95, 0.55);
            this.group.add(nozzle);
            // ノズル先端の発火ベル（円錐）
            const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 0.10, 8), flameMat);
            bell.rotation.x = Math.PI / 2;
            bell.position.set(0.3, 0.95, 0.85);
            this.group.add(bell);
            // パイロットフレーム（先端に小さな炎）
            const pilotMat = new THREE.MeshBasicMaterial({ color: 0xFF8822 });
            const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), pilotMat);
            pilot.position.set(0.3, 0.95, 0.93);
            pilot.scale.set(0.7, 1.5, 0.7);
            this.group.add(pilot);
            this.flamePilot = pilot;
            // グリップ
            const gripMat = new THREE.MeshStandardMaterial({ color: 0x2a1808, roughness: 0.85 });
            const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.13, 0.06), gripMat);
            grip.position.set(0.3, 0.85, -0.18);
            this.group.add(grip);
        } else if (this.subType === 'jetpack_raider') {
            // 片手サブマシンガン。短い3連射の視覚的な発射元。
            const smgMat = new THREE.MeshStandardMaterial({ color: 0x24282A, metalness: 0.55, roughness: 0.42 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.10, 0.36), smgMat);
            body.position.set(0.30, 0.88, 0.22);
            this.group.add(body);
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.44, 7), smgMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0.30, 0.88, 0.60);
            this.group.add(barrel);
            const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.08), smgMat);
            mag.position.set(0.30, 0.73, 0.18);
            mag.rotation.x = -0.18;
            this.group.add(mag);
            const muzzle = new THREE.Mesh(
                new THREE.RingGeometry(0.026, 0.045, 10),
                new THREE.MeshBasicMaterial({ color: 0x080808, side: THREE.DoubleSide })
            );
            muzzle.position.set(0.30, 0.88, 0.83);
            this.group.add(muzzle);
        } else if (this.subType === 'mummy') {
            // 武器なし。腕を前に突き出す姿勢のみ（腕の位置調整は AI で）。
            // 替わりに包帯の手 = 鉤爪のような表情を出すため、両手の前にひっかき指を追加
            const clawMat = new THREE.MeshStandardMaterial({ color: 0xC4B488, roughness: 0.95 });
            for (let z of [-0.36, 0.36]) {
                for (let i = 0; i < 3; i++) {
                    const claw = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.08, 4), clawMat);
                    claw.position.set(0.05, 0.72, z + (i - 1) * 0.04);
                    claw.rotation.z = Math.PI / 2;
                    this.group.add(claw);
                }
            }
        } else if (this.subType === 'sniper' || this.subType === 'perched_sniper') {
            // 長いライフル + 大きなスコープ
            const sniperMat = new THREE.MeshStandardMaterial({ color: 0x2a2218, metalness: 0.4, roughness: 0.55 });
            // 長いバレル
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.4, 8), sniperMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0.30, 0.95, 0.4);
            this.group.add(barrel);
            // 機関部（厚いブロック）
            const breech = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.30), sniperMat);
            breech.position.set(0.30, 0.95, -0.10);
            this.group.add(breech);
            // 木製ストック
            const stockMat = new THREE.MeshStandardMaterial({ color: 0x4a2818, roughness: 0.85 });
            const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.30), stockMat);
            stock.position.set(0.30, 0.92, -0.32);
            this.group.add(stock);
            // スコープ（大きな円筒）
            const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.32, 10), sniperMat);
            scope.rotation.x = Math.PI / 2;
            scope.position.set(0.30, 1.04, 0.05);
            this.group.add(scope);
            // スコープのレンズ（赤い反射）
            const scopeLensMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, metalness: 0.6, roughness: 0.3, emissive: 0x331100 });
            const scopeLens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.01, 10), scopeLensMat);
            scopeLens.rotation.x = Math.PI / 2;
            scopeLens.position.set(0.30, 1.04, 0.21);
            this.group.add(scopeLens);
            // 二脚（バイポッド）
            const bipodMat = new THREE.MeshStandardMaterial({ color: 0x2a2218, metalness: 0.5, roughness: 0.5 });
            for (let s of [-1, 1]) {
                const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.20, 5), bipodMat);
                leg.position.set(0.30, 0.85, 0.55);
                leg.rotation.x = s * 0.4;
                this.group.add(leg);
            }
        } else if (this.subType === 'hunter') {
            // 大型のレバーアクション猟銃（リピーター）
            const huntMat = new THREE.MeshStandardMaterial({ color: 0x3a2818, metalness: 0.3, roughness: 0.6 });
            const stockMat = new THREE.MeshStandardMaterial({ color: 0x6E4828, roughness: 0.85 });
            // バレル
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.0, 8), huntMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0.30, 0.92, 0.30);
            this.group.add(barrel);
            // 弾倉チューブ（バレル下）
            const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.85, 6), huntMat);
            tube.rotation.x = Math.PI / 2;
            tube.position.set(0.30, 0.86, 0.27);
            this.group.add(tube);
            // 機関部 + レバー
            const action = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.10, 0.20), huntMat);
            action.position.set(0.30, 0.91, -0.10);
            this.group.add(action);
            const lever = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.10, 0.06), huntMat);
            lever.position.set(0.30, 0.80, -0.05);
            this.group.add(lever);
            // ストック
            const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.30), stockMat);
            stock.position.set(0.30, 0.92, -0.32);
            this.group.add(stock);
        } else if (this.subType === 'ninja') {
            // 刀（背中の鞘 + 手に短刀）
            const sayaMat = new THREE.MeshStandardMaterial({ color: 0x18162A, roughness: 0.85 });
            const saya = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.7), sayaMat);
            saya.position.set(-0.30, 1.10, 0);
            saya.rotation.x = -0.3;
            this.group.add(saya);
            // 鞘の留め金（金色）
            const goldMat2 = new THREE.MeshStandardMaterial({ color: 0xCFAE54, metalness: 0.6, roughness: 0.4 });
            const guard = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.04), goldMat2);
            guard.position.set(-0.20, 1.32, 0);
            guard.rotation.x = -0.3;
            this.group.add(guard);
            // 柄（手に持つ）
            const handleMat = new THREE.MeshStandardMaterial({ color: 0x18162A, roughness: 0.9 });
            const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.18), handleMat);
            handle.position.set(0.32, 0.92, 0.10);
            this.group.add(handle);
            // 刃（金属、きらめく）
            const bladeMat = new THREE.MeshStandardMaterial({ color: 0xDDDDDD, metalness: 0.85, roughness: 0.15 });
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.45), bladeMat);
            blade.position.set(0.32, 0.92, 0.40);
            this.group.add(blade);
            // 鍔
            const tsuba = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.02), goldMat2);
            tsuba.position.set(0.32, 0.92, 0.20);
            this.group.add(tsuba);
        } else if (this.subType === 'juggernaut') {
            // 重装ショットキャノン
            const gunMat = new THREE.MeshStandardMaterial({ color: 0x2E3138, roughness: 0.45, metalness: 0.5 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.20, 0.55), gunMat);
            body.position.set(0.30, 0.92, 0.05);
            this.group.add(body);
            for (const z of [-0.09, 0.09]) {
                const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.60, 10), gunMat);
                barrel.rotation.x = Math.PI / 2;
                barrel.position.set(0.30, 0.97, 0.48 + z);
                this.group.add(barrel);
            }
            const shield = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.16, 0.10), gunMat);
            shield.position.set(0.30, 0.93, -0.22);
            this.group.add(shield);
        } else if (this.subType === 'commando') {
            // 精鋭カービン: 短銃身 + サプレッサー + レーザーサイト
            const gunMat = new THREE.MeshStandardMaterial({ color: 0x171D1E, roughness: 0.38, metalness: 0.65 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.13, 0.44), gunMat);
            body.position.set(0.30, 0.90, 0.03);
            this.group.add(body);
            const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.72, 8), gunMat);
            barrel.rotation.x = Math.PI / 2;
            barrel.position.set(0.30, 0.91, 0.48);
            this.group.add(barrel);
            const suppressor = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.25, 10), gunMat);
            suppressor.rotation.x = Math.PI / 2;
            suppressor.position.set(0.30, 0.91, 0.90);
            this.group.add(suppressor);
            const sight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.16), gunMat);
            sight.position.set(0.30, 1.02, 0.18);
            this.group.add(sight);
            const laser = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 4), new THREE.MeshBasicMaterial({ color: 0x44DDFF }));
            laser.position.set(0.30, 0.93, 1.02);
            this.group.add(laser);
        } else if (this.subType === 'demolition') {
            // 多連装グレネードランチャー
            const gunMat = new THREE.MeshStandardMaterial({ color: 0x282B2E, roughness: 0.45, metalness: 0.55 });
            const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.42), gunMat);
            body.position.set(0.30, 0.92, 0.00);
            this.group.add(body);
            const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.16, 12), gunMat);
            drum.position.set(0.30, 0.76, 0.03);
            this.group.add(drum);
            for (const z of [-0.09, 0.09]) {
                const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, 0.62, 8), gunMat);
                barrel.rotation.x = Math.PI / 2;
                barrel.position.set(0.30, 0.94, 0.42 + z);
                this.group.add(barrel);
            }
            const muzzle = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.085, 10), new THREE.MeshBasicMaterial({ color: 0x080808, side: THREE.DoubleSide }));
            muzzle.position.set(0.30, 0.94, 0.78);
            this.group.add(muzzle);
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
            case 'flamethrower':
                this._aiFlamethrower(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'mummy':
                this._aiMummy(dt, dist, dirToPlayer, playerPos);
                break;
            case 'sniper':
                this._aiSniper(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'hunter':
                this._aiHunter(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'ninja':
                this._aiNinja(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'juggernaut':
                this._aiJuggernaut(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'commando':
                this._aiCommando(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'demolition':
                this._aiDemolition(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'jetpack_raider':
                this._aiJetpackRaider(dt, dist, dirToPlayer, playerPos, elapsedTime);
                break;
            case 'perched_sniper':
                this._aiPerchedSniper(dt, dist, dirToPlayer, playerPos, elapsedTime);
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

        // ジェットパック兵は低空ホバー。地上歩行バウンスを掛けず、脚と炎だけを揺らす。
        if (this.airborne) {
            const hover = Math.sin(elapsedTime * 6 + this.weavePhase) * 0.12;
            this.group.position.y += ((this.jetpackBaseHeight + hover) - this.group.position.y) * Math.min(1, dt * 7);
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
            this.leftLeg.rotation.z = -0.18 + Math.sin(elapsedTime * 8) * 0.08;
            this.rightLeg.rotation.z = 0.18 + Math.cos(elapsedTime * 8) * 0.08;
            if (this.leftLowerLeg) this.leftLowerLeg.rotation.z = -0.16 + Math.sin(elapsedTime * 7) * 0.06;
            if (this.rightLowerLeg) this.rightLowerLeg.rotation.z = 0.16 + Math.cos(elapsedTime * 7) * 0.06;
            if (this.jetFlames) {
                const boost = this.jetpackBoostTimer > 0 ? 1.75 : 1.0;
                this.jetFlames.forEach((flame, idx) => {
                    const s = boost * (0.75 + Math.sin(elapsedTime * 18 + idx) * 0.18 + Math.random() * 0.18);
                    flame.scale.set(0.85 * s, 1.15 * s, 0.85 * s);
                    flame.material.opacity = THREE.MathUtils.clamp(0.55 + s * 0.18, 0.45, 0.95);
                });
            }
            this._animateUpperBody(elapsedTime, Math.sin(elapsedTime * 8), true);
            return;
        }

        // 屋上配置スナイパーは静止 — 歩行アニメ・バウンス・ロールを行わず Y を固定
        if (this.perched) {
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
            this.leftLeg.rotation.z = -0.08;
            this.rightLeg.rotation.z = 0.08;
            if (this.leftLowerLeg) this.leftLowerLeg.rotation.z = 0.05;
            if (this.rightLowerLeg) this.rightLowerLeg.rotation.z = -0.05;
            this.group.position.y = this.perchY;
            this.group.rotation.z = 0;
            if (this.helmetMesh) this.helmetMesh.rotation.z = 0;
            if (this.headMesh) this.headMesh.rotation.z = 0;
            this._animateUpperBody(elapsedTime, 0, true);
            return;
        }

        // 歩行アニメーション（Metal Slug 風の大袈裟な揺れ）
        // モデルの前方はローカル +X なので、脚は Z 軸回転で前後に振る。
        const cycleSpeed = this.subType === 'knife' ? 22 : (this.subType === 'officer' ? 12 : (this.subType === 'juggernaut' ? 9 : 13));
        this.walkCycle += dt * cycleSpeed;
        const swing = Math.sin(this.walkCycle);
        const heavyScale = this.subType === 'juggernaut' ? 0.72 : 1.0;
        const stride = (this.subType === 'knife' || this.subType === 'ninja') ? 0.46 : 0.34;
        const legSwing = swing * stride * heavyScale;
        this.leftLeg.rotation.x = 0;
        this.rightLeg.rotation.x = 0;
        this.leftLeg.rotation.z = -legSwing;
        this.rightLeg.rotation.z = legSwing;

        const leftPlant = Math.max(0, swing);
        const rightPlant = Math.max(0, -swing);
        if (this.leftLowerLeg) this.leftLowerLeg.rotation.z = leftPlant * 0.28 - rightPlant * 0.10;
        if (this.rightLowerLeg) this.rightLowerLeg.rotation.z = rightPlant * -0.28 + leftPlant * 0.10;
        if (this.leftBoot) this.leftBoot.rotation.z = leftPlant * 0.16 - rightPlant * 0.08;
        if (this.rightBoot) this.rightBoot.rotation.z = rightPlant * -0.16 + leftPlant * 0.08;

        // 上下バウンス（接地時は低く、足を振り抜く時だけ少し浮く）
        const bounce = (1 - Math.abs(swing)) * 0.035 + Math.abs(Math.cos(this.walkCycle)) * 0.018;
        this.group.position.y = bounce;
        // 軽い左右ロール
        this.group.rotation.z = Math.cos(this.walkCycle) * 0.035 * heavyScale;
        this._animateUpperBody(elapsedTime, swing);
        // ヘルメットの微小な揺れ
        if (this.helmetMesh) {
            this.helmetMesh.rotation.z = Math.sin(this.walkCycle * 0.5) * 0.025;
        }
        if (this.headMesh) {
            this.headMesh.rotation.z = Math.sin(this.walkCycle * 0.5) * 0.02;
        }
    }

    _animateUpperBody(elapsedTime, swing = 0, steadyAim = false) {
        const firingPulse = Math.max(0, 1 - (elapsedTime - this.lastFireTime) * 10);
        const attackPose = this.aiState === 'attack' || this.aiState === 'charge' || steadyAim;
        const armSwing = attackPose ? 0.08 : 0.20;
        const recoil = attackPose ? firingPulse * 0.08 : 0;

        if (this.leftArmMesh) {
            this.leftArmMesh.rotation.z = -swing * armSwing - recoil;
            this.leftArmMesh.rotation.x = attackPose ? -0.18 : Math.cos(this.walkCycle + Math.PI) * 0.08;
        }
        if (this.rightArmMesh) {
            this.rightArmMesh.rotation.z = swing * armSwing + recoil;
            this.rightArmMesh.rotation.x = attackPose ? 0.18 : Math.cos(this.walkCycle) * 0.08;
        }
        if (this.leftHandMesh) {
            this.leftHandMesh.position.y = 0.72 + Math.cos(this.walkCycle + Math.PI) * (attackPose ? 0.015 : 0.045);
        }
        if (this.rightHandMesh) {
            this.rightHandMesh.position.y = 0.72 + Math.cos(this.walkCycle) * (attackPose ? 0.015 : 0.045);
        }

        this.dynamicBits.forEach((bit, idx) => {
            const wave = Math.sin(elapsedTime * 7.0 + bit.phase + idx * 0.7);
            bit.mesh.rotation.z = bit.baseRotZ + wave * bit.amp;
            bit.mesh.rotation.x = bit.baseRotX + Math.cos(elapsedTime * 5.5 + bit.phase) * bit.amp * 0.45;
        });
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

    _aiFlamethrower(dt, dist, dir, playerPos, elapsed) {
        // 接近して連続炎を吹く
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.45);
        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireFlame(playerPos);
        }
        // パイロット火のフリッカー
        if (this.flamePilot) {
            const s = 0.8 + Math.sin(elapsed * 18) * 0.2 + Math.random() * 0.1;
            this.flamePilot.scale.set(0.7 * s, 1.5 * s, 0.7 * s);
        }
    }

    _aiMummy(dt, dist, dir, playerPos) {
        // よろよろ歩きで突進。蛇行を強くしてゾンビ感
        this.aiState = 'charge';
        this.weavePhase += dt * 1.2;
        const sway = Math.sin(this.weavePhase) * 0.6;
        const perp = new THREE.Vector3(-dir.z, 0, dir.x);
        const step = new THREE.Vector3(
            dir.x + perp.x * sway,
            0,
            dir.z + perp.z * sway
        ).multiplyScalar(this.speed * dt);
        this.group.position.add(step);
    }

    _aiPerchedSniper(dt, dist, dir, playerPos, elapsed) {
        // 完全静止。プレイヤーに照準を合わせ、レーザーサイトを伸ばし、定期的に高威力弾を放つ。
        // 高所から見下ろす角度で発射する。
        this.aiState = 'attack';

        // ライフルの銃口（モデルローカル座標）からプレイヤーまでの実距離
        const muzzleLocal = new THREE.Vector3(0.30, 0.95, 0.55);
        const muzzleWorld = muzzleLocal.clone().applyMatrix4(this.group.matrixWorld);
        const beamLen = muzzleWorld.distanceTo(playerPos);

        if (this.laserSight) {
            this.laserSight.visible = dist <= this.attackRange;
            // 単位シリンダーを z 方向に伸ばす（ローカル空間でターゲットを見る）
            this.laserSight.scale.set(1, 1, beamLen);
        }

        // 銃口の発射クールダウン直前は赤いドットが点滅して "狙い済み" を示す
        if (this.laserDot) {
            const aimReady = (elapsed - this.lastFireTime) > (this.fireRate - 0.7);
            this.laserDot.visible = aimReady;
            this.laserDot.scale.setScalar(aimReady ? (1.0 + Math.sin(elapsed * 18) * 0.4) : 1.0);
        }

        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._firePerchedShot(playerPos);
        }
    }

    _firePerchedShot(playerPos) {
        // 高所から発射。Y を含めた 3D 方向にする
        const muzzleLocal = new THREE.Vector3(0.30, 0.95, 0.55);
        const muzzlePos = muzzleLocal.applyMatrix4(this.group.matrixWorld);
        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos).normalize();
        const shot = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 42,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 90,
        });
        this.projectiles.push(shot);
    }

    _aiSniper(dt, dist, dir, playerPos, elapsed) {
        // 遠距離から撃つ。射程外でのみ移動、射程内では停止して照準
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.05);
        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireSniperShot(playerPos);
        }
    }

    _aiHunter(dt, dist, dir, playerPos, elapsed) {
        // 通常ライフルと同様だが速度高め、射程やや短め
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 1.0 : 0.5);
        if (dist <= this.attackRange) this._fire(playerPos, elapsed);
    }

    _aiNinja(dt, dist, dir, playerPos, elapsed) {
        // 高速突進。射程内で手裏剣を投げる。射程外では速い導線移動
        this.aiState = dist > 6 ? 'advance' : (dist > 2 ? 'attack' : 'charge');
        if (dist > 2) {
            this._advanceCrossing(dt, dist > this.attackRange ? 1.2 : 0.7);
        } else {
            // 至近では直行突進
            this.group.position.add(dir.clone().multiplyScalar(this.speed * dt));
        }
        if (dist > 3 && dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireShuriken(playerPos);
        }
    }

    _aiJuggernaut(dt, dist, dir, playerPos, elapsed) {
        // 重装歩兵: ゆっくり圧力をかけ、近中距離で散弾をばら撒く
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this._advanceCrossing(dt, dist > this.attackRange ? 0.85 : 0.38);
        if (dist < 3.2) {
            this.group.position.add(dir.clone().multiplyScalar(this.speed * 0.4 * dt));
        }
        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireScatterShot(playerPos);
        }
    }

    _aiCommando(dt, dist, dir, playerPos, elapsed) {
        // 精鋭コマンド: 射線を横切りながら左右へ切り返し、近すぎると後退する。
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this.specialTimer += dt;
        this.weavePhase += dt * 5.0;

        const d = this._dirToCross || dir;
        const perp = new THREE.Vector3(-d.z, 0, d.x);
        const zig = Math.sin(this.weavePhase * 1.6) > 0 ? 1 : -1;
        const retreat = dist < 5.5 ? -0.8 : 0.0;
        const move = d.clone()
            .multiplyScalar(dist > this.attackRange ? 1.25 : 0.62 + retreat)
            .add(perp.multiplyScalar(zig * 0.72));
        if (move.lengthSq() > 0.001) {
            move.normalize().multiplyScalar(this.speed * dt);
            this.group.position.add(move);
        }

        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate && this.burstCount === 0) {
            this.lastFireTime = elapsed;
            this.burstCount = 4;
            this.burstTimer = 0.04;
        }

        // たまに鋭く横へダッシュして狙いを外す。
        if (dist < this.attackRange * 1.15 && this.specialTimer > 2.4) {
            this.group.position.add(perp.normalize().multiplyScalar((Math.random() < 0.5 ? -1 : 1) * 1.7));
            this.specialTimer = 0;
        }
    }

    _aiDemolition(dt, dist, dir, playerPos, elapsed) {
        // 爆破工兵: 中距離を維持し、横移動しながら複数弾で面を潰す。
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this.weavePhase += dt * 2.4;
        const d = this._dirToCross || dir;
        const perp = new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(Math.sin(this.weavePhase) * 0.9);
        const rangeControl = dist < 9 ? -0.45 : (dist > this.attackRange ? 1.0 : 0.28);
        const move = d.clone().multiplyScalar(rangeControl).add(perp);
        if (move.lengthSq() > 0.001) {
            move.normalize().multiplyScalar(this.speed * dt);
            this.group.position.add(move);
        }

        if (dist <= this.attackRange && dist > 5 && elapsed - this.lastFireTime > this.fireRate) {
            this.lastFireTime = elapsed;
            this._fireGrenadeCluster(playerPos);
        }
    }

    _aiJetpackRaider(dt, dist, dir, playerPos, elapsed) {
        // 低空を横切り、短いブーストで射線を外しながら3連射と爆弾投下を行う。
        this.aiState = dist > this.attackRange ? 'advance' : 'attack';
        this.specialTimer += dt;
        this.jetpackBombTimer += dt;
        this.weavePhase += dt * 3.3;
        this.jetpackBoostTimer = Math.max(0, this.jetpackBoostTimer - dt);

        const d = (this._dirToCross || dir).clone();
        const perp = new THREE.Vector3(-d.z, 0, d.x);
        const orbit = Math.sin(this.weavePhase) * 0.9;
        const rangeControl = dist > this.attackRange ? 1.05 : (dist < 7 ? -0.35 : 0.34);
        let move = d.multiplyScalar(rangeControl).add(perp.clone().multiplyScalar(orbit));

        if (this.specialTimer > 2.5) {
            this.jetpackBoostTimer = 0.42;
            this.specialTimer = 0;
            const side = this.group.position.x < playerPos.x ? -1 : 1;
            move = perp.multiplyScalar(side * 2.4).add(dir.clone().multiplyScalar(-0.2));
        }

        if (move.lengthSq() > 0.001) {
            const speedScale = this.jetpackBoostTimer > 0 ? 1.85 : 0.82;
            move.normalize().multiplyScalar(this.speed * speedScale * dt);
            this.group.position.add(move);
            this.group.rotation.z = THREE.MathUtils.clamp(-move.x * 1.7, -0.34, 0.34);
        }

        if (dist <= this.attackRange && elapsed - this.lastFireTime > this.fireRate && this.jetpackBurstShots <= 0) {
            this.lastFireTime = elapsed;
            this.jetpackBurstShots = 3;
            this.jetpackBurstTimer = 0.02;
        }

        if (this.jetpackBurstShots > 0) {
            this.jetpackBurstTimer -= dt;
            if (this.jetpackBurstTimer <= 0) {
                this._fireJetpackShot(playerPos);
                this.jetpackBurstShots--;
                this.jetpackBurstTimer = 0.16;
            }
        }

        const abovePlayer = Math.abs(this.group.position.x - playerPos.x) < 5.5 && Math.abs(this.group.position.z - playerPos.z) < 9.0;
        if (abovePlayer && this.jetpackBombTimer > 3.1) {
            this.jetpackBombTimer = 0;
            this._dropJetpackBomb(playerPos);
        }
    }

    _fireJetpackShot(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.78;
        const target = playerPos.clone();
        target.y += 1.0;
        const dir = new THREE.Vector3().subVectors(target, muzzlePos);
        dir.x += (Math.random() - 0.5) * 0.09;
        dir.z += (Math.random() - 0.5) * 0.09;
        dir.normalize();

        const bullet = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 23,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 58,
        });
        this.projectiles.push(bullet);
    }

    _dropJetpackBomb(playerPos) {
        const pos = this.group.position.clone();
        pos.y += 0.25;
        const towardPlayer = new THREE.Vector3().subVectors(playerPos, pos);
        towardPlayer.y = 0;
        if (towardPlayer.lengthSq() > 0.01) towardPlayer.normalize();
        else towardPlayer.set(0, 0, 1);
        const dropDir = new THREE.Vector3(towardPlayer.x * 0.22, -1, towardPlayer.z * 0.22).normalize();

        const bomb = new Projectile(this.scene, {
            position: pos,
            direction: dropDir,
            speed: 3.2,
            damage: this.damage + 8,
            owner: 'enemy',
            type: 'bomb',
            maxDistance: 45,
            gravity: 18,
        });
        this.projectiles.push(bomb);
    }

    _fireFlame(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.95;
        // 砲口前方（モデル方向）に少しオフセット
        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();
        muzzlePos.add(dir.clone().multiplyScalar(0.95));

        // 短射程・低速・スプレッド
        const spread = (Math.random() - 0.5) * 0.25;
        const flameDir = dir.clone();
        flameDir.x += spread;
        flameDir.z -= spread * 0.3;
        flameDir.normalize();

        const flame = new Projectile(this.scene, {
            position: muzzlePos,
            direction: flameDir,
            speed: 11,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 9,
        });
        this.projectiles.push(flame);
    }

    _fireSniperShot(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.95;
        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();
        const shot = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 38,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 80,
        });
        this.projectiles.push(shot);
    }

    _fireShuriken(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.9;
        const dir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        dir.y = 0;
        dir.normalize();
        const shuriken = new Projectile(this.scene, {
            position: muzzlePos,
            direction: dir,
            speed: 18,
            damage: this.damage,
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 25,
        });
        this.projectiles.push(shuriken);
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

    _fireScatterShot(playerPos) {
        const muzzlePos = this.group.position.clone();
        muzzlePos.y += 0.95;

        const baseDir = new THREE.Vector3().subVectors(playerPos, muzzlePos);
        baseDir.y = 0;
        baseDir.normalize();

        const pelletDamage = Math.max(7, Math.floor(this.damage * 0.45));
        for (let i = 0; i < 5; i++) {
            const spread = (i - 2) * 0.07 + (Math.random() - 0.5) * 0.03;
            const dir = baseDir.clone();
            dir.x += spread;
            dir.z -= spread * 0.28;
            dir.normalize();
            const pellet = new Projectile(this.scene, {
                position: muzzlePos.clone(),
                direction: dir,
                speed: 17,
                damage: pelletDamage,
                owner: 'enemy',
                type: 'bullet',
                maxDistance: 24,
            });
            this.projectiles.push(pellet);
        }
    }

    _fireGrenadeCluster(playerPos) {
        const offsets = [-2.2, 0, 2.2];
        for (const off of offsets) {
            const target = playerPos.clone();
            target.x += off + (Math.random() - 0.5) * 0.8;
            target.z += (Math.random() - 0.5) * 1.4;
            this._fireGrenade(target);
        }
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
