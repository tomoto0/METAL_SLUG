import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

/**
 * 航空系の敵
 * subType: 'scout_heli' | 'attack_heli' | 'bomber' | 'fighter' | 'drone' | 'interceptor' | 'gunship' | 'tomahawk'
 *          | 'heavy_heli' (新: 大型輸送/攻撃ヘリ、Wave 30+ 中東市街地)
 *          | 'combat_drone' (新: 中東ステージのUCAV、Wave 30+)
 */
export class Aircraft extends Enemy {
    constructor(scene, {
        position,
        subType = 'scout_heli',
        lowShadow = false,
    }) {
        // 航空機スコア（原作 Metal Slug 相当）
        //   scout_heli: 800 / attack_heli (R-Shobu系): 2000 / bomber: 1500 / fighter: 1200
        const SPECS = {
            scout_heli:   { hp: 25,  speed: 5,  scoreValue: 800,  fireRate: 1.0,  damage: 8  },
            attack_heli:  { hp: 75,  speed: 4,  scoreValue: 2000, fireRate: 2.5,  damage: 15 },
            bomber:       { hp: 60,  speed: 7,  scoreValue: 1500, fireRate: 2.0,  damage: 20 },
            fighter:      { hp: 25,  speed: 12, scoreValue: 1200, fireRate: 0.15, damage: 5  },
            drone:        { hp: 18,  speed: 9,  scoreValue: 900,  fireRate: 1.05, damage: 6  },
            interceptor:  { hp: 50,  speed: 14, scoreValue: 2400, fireRate: 0.38, damage: 7  },
            gunship:      { hp: 150, speed: 3.2, scoreValue: 3800, fireRate: 1.8,  damage: 18 },
            tomahawk:     { hp: 22,  speed: 17, scoreValue: 1800, fireRate: 99,   damage: 28 },
            heavy_heli:   { hp: 240, speed: 3.0, scoreValue: 5500, fireRate: 1.5,  damage: 22 },
            combat_drone: { hp: 38,  speed: 11, scoreValue: 1400, fireRate: 0.55, damage: 9  },
        };
        const spec = SPECS[subType] || SPECS.scout_heli;

        super(scene, { position, ...spec, type: 'aircraft' });
        this.subType = subType;
        // Wave 13+ では shadow caster を間引いて shadow pass を軽くする
        this._lowShadow = lowShadow;

        // 飛行高度（プレイヤー戦車の砲身仰角で届く低空に調整）
        // 砲塔高 ≈ 1.2m、目安として 4〜7m を主役の高度に。
        const HEIGHTS = {
            scout_heli:   { base: 5.0,  jitter: 1.0 },
            attack_heli:  { base: 5.5,  jitter: 1.0 },
            bomber:       { base: 6.5,  jitter: 1.0 },
            fighter:      { base: 6.0,  jitter: 1.0 },
            drone:        { base: 4.8,  jitter: 0.8 },
            interceptor:  { base: 6.2,  jitter: 0.9 },
            gunship:      { base: 6.0,  jitter: 0.6 },
            tomahawk:     { base: 3.8,  jitter: 0.7 },
            heavy_heli:   { base: 6.8,  jitter: 0.8 },
            combat_drone: { base: 5.6,  jitter: 1.0 },
        };
        const h = HEIGHTS[subType] || HEIGHTS.scout_heli;
        this.flightHeight = h.base + (Math.random() - 0.5) * 2 * h.jitter;
        this.group.position.y = this.flightHeight;

        // AI状態
        this.aiPhase = 0;
        this.aiTimer = 0;
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitRadius = 15 + Math.random() * 10;
        this.diveProgress = 0;
        this.burstCount = 0;
        this.entryDir = Math.random() > 0.5 ? 1 : -1; // 進入方向
        this.homingDir = null;

        // ローター回転用
        this.rotorAngle = 0;
        this.extraRotors = [];

        this._buildModel();
        this._recordMaterials();
        this.scene.add(this.group);
    }

    _buildModel() {
        switch (this.subType) {
            case 'scout_heli':
                this._buildScoutHeli();
                break;
            case 'attack_heli':
                this._buildAttackHeli();
                break;
            case 'bomber':
                this._buildBomber();
                break;
            case 'fighter':
                this._buildFighter();
                break;
            case 'drone':
                this._buildDrone();
                break;
            case 'interceptor':
                this._buildInterceptor();
                break;
            case 'gunship':
                this._buildGunship();
                break;
            case 'tomahawk':
                this._buildTomahawk();
                break;
            case 'heavy_heli':
                this._buildHeavyHeli();
                break;
            case 'combat_drone':
                this._buildCombatDrone();
                break;
        }
    }

    _buildTomahawk() {
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0xE8ECEE, roughness: 0.45, metalness: 0.25,
        });
        const noseMat = new THREE.MeshStandardMaterial({
            color: 0xF5F7F8, roughness: 0.35, metalness: 0.2,
        });
        const finMat = new THREE.MeshStandardMaterial({
            color: 0xC7CCD1, roughness: 0.55, metalness: 0.15,
        });
        const stripeMat = new THREE.MeshStandardMaterial({
            color: 0xB0B7BD, roughness: 0.5, metalness: 0.2,
        });
        const flameMat = new THREE.MeshBasicMaterial({
            color: 0xFFD28A, transparent: true, opacity: 0.8,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });

        // Object3D.lookAt の規約に従い local +Z を進行方向にレイアウト
        // （弾頭が常に飛翔方向を向く）。
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 2.6, 10), bodyMat);
        body.rotation.x = Math.PI / 2;
        this.group.add(body);

        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.52, 10), noseMat);
        nose.rotation.x = Math.PI / 2;
        nose.position.z = 1.55;
        this.group.add(nose);

        const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.12, 10), stripeMat);
        intake.rotation.x = Math.PI / 2;
        intake.position.z = 0.72;
        this.group.add(intake);

        const rear = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.18, 10), stripeMat);
        rear.rotation.x = Math.PI / 2;
        rear.position.z = -1.36;
        this.group.add(rear);

        // 水平尾翼（左右に張り出す）
        for (const x of [-0.16, 0.16]) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.42), finMat);
            fin.position.set(x, 0, -0.88);
            this.group.add(fin);
        }
        // 垂直尾翼（上下）
        for (const y of [-0.12, 0.12]) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.2, 0.42), finMat);
            fin.position.set(0, y, -0.88);
            this.group.add(fin);
        }

        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 1.35), stripeMat);
        stripe.position.set(0, 0.13, 0.3);
        this.group.add(stripe);

        this.jetCore = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.42, 8), flameMat);
        this.jetCore.rotation.x = -Math.PI / 2; // 先端を -Z（後方）へ
        this.jetCore.position.z = -1.58;
        this.group.add(this.jetCore);
    }

    // ============================================
    // 偵察ヘリ
    // ============================================
    _buildScoutHeli() {
        const C = {
            body: 0x4682B4,
            bodyDark: 0x365F82,
            cockpit: 0x88CCEE,
            metal: 0x5A5A5A,
            rotor: 0x3A3A3A,
            skid: 0x4A4A4A,
        };

        // 胴体（球状）
        const bodyGeo = new THREE.SphereGeometry(0.9, 12, 8);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: C.body, roughness: 0.5, metalness: 0.2
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.scale.set(1.3, 0.8, 0.9);
        body.castShadow = true;
        this.group.add(body);

        // コックピット（前面ガラス）
        const cockpitGeo = new THREE.SphereGeometry(0.55, 10, 8, 0, Math.PI);
        const cockpitMat = new THREE.MeshStandardMaterial({
            color: C.cockpit, roughness: 0.1, metalness: 0.1,
            transparent: true, opacity: 0.7,
        });
        const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
        cockpit.rotation.y = -Math.PI / 2;
        cockpit.position.set(0.5, 0.1, 0);
        cockpit.scale.set(0.8, 0.7, 0.9);
        this.group.add(cockpit);

        // テイルブーム
        const tailGeo = new THREE.CylinderGeometry(0.15, 0.25, 1.8, 8);
        const tailMat = new THREE.MeshStandardMaterial({ color: C.bodyDark, roughness: 0.6 });
        const tail = new THREE.Mesh(tailGeo, tailMat);
        tail.rotation.z = Math.PI / 2 + 0.1;
        tail.position.set(-1.5, 0.2, 0);
        this.group.add(tail);

        // テイルフィン
        const finGeo = new THREE.BoxGeometry(0.5, 0.5, 0.06);
        const finMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.5 });
        const fin = new THREE.Mesh(finGeo, finMat);
        fin.position.set(-2.2, 0.4, 0);
        this.group.add(fin);

        // メインローター
        this.mainRotor = new THREE.Group();
        const rotorBladeGeo = new THREE.BoxGeometry(3.5, 0.04, 0.25);
        const rotorMat = new THREE.MeshStandardMaterial({
            color: C.rotor, roughness: 0.3, metalness: 0.5
        });
        const blade1 = new THREE.Mesh(rotorBladeGeo, rotorMat);
        this.mainRotor.add(blade1);
        const blade2 = new THREE.Mesh(rotorBladeGeo, rotorMat);
        blade2.rotation.y = Math.PI / 2;
        this.mainRotor.add(blade2);
        this.mainRotor.position.y = 0.75;
        this.group.add(this.mainRotor);

        // ローターブラー（半透明ディスク）
        const blurDisc = new THREE.Mesh(
            new THREE.CircleGeometry(1.85, 24),
            new THREE.MeshBasicMaterial({
                color: 0xCCCCCC, transparent: true, opacity: 0.18,
                depthWrite: false, side: THREE.DoubleSide,
            })
        );
        blurDisc.rotation.x = -Math.PI / 2;
        blurDisc.position.y = 0.78;
        this.group.add(blurDisc);

        // ローターハブ
        const hubGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.15, 8);
        const hubMat = new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.5 });
        const hub = new THREE.Mesh(hubGeo, hubMat);
        hub.position.y = 0.75;
        this.group.add(hub);

        // 機首機銃（小型）
        const noseGun = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.04, 0.4, 6),
            new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.6, roughness: 0.4 })
        );
        noseGun.rotation.z = Math.PI / 2;
        noseGun.position.set(1.0, -0.25, 0);
        this.group.add(noseGun);

        // ナビゲーションライト（緑右・赤左 + 機尾白）
        const navGeoSm = new THREE.SphereGeometry(0.05, 6, 4);
        const navR = new THREE.Mesh(navGeoSm, new THREE.MeshBasicMaterial({ color: 0xFF2030 }));
        navR.position.set(0.2, -0.05, -0.85);
        this.group.add(navR);
        const navG = new THREE.Mesh(navGeoSm, new THREE.MeshBasicMaterial({ color: 0x20FF40 }));
        navG.position.set(0.2, -0.05, 0.85);
        this.group.add(navG);
        const navW = new THREE.Mesh(navGeoSm, new THREE.MeshBasicMaterial({ color: 0xFFEEAA }));
        navW.position.set(-2.4, 0.4, 0);
        this.group.add(navW);

        // テイルローター
        this.tailRotor = new THREE.Group();
        const tBladeGeo = new THREE.BoxGeometry(0.05, 0.8, 0.12);
        const tBlade1 = new THREE.Mesh(tBladeGeo, rotorMat);
        this.tailRotor.add(tBlade1);
        const tBlade2 = new THREE.Mesh(tBladeGeo, rotorMat);
        tBlade2.rotation.z = Math.PI / 2;
        this.tailRotor.add(tBlade2);
        this.tailRotor.position.set(-2.2, 0.4, 0.1);
        this.group.add(this.tailRotor);

        // スキッド（着陸脚）
        const skidMat = new THREE.MeshStandardMaterial({ color: C.skid, roughness: 0.5 });
        for (let z of [-0.5, 0.5]) {
            const skidGeo = new THREE.BoxGeometry(1.5, 0.04, 0.04);
            const skid = new THREE.Mesh(skidGeo, skidMat);
            skid.position.set(0, -0.7, z);
            this.group.add(skid);

            // 支柱
            for (let x of [-0.3, 0.4]) {
                const strutGeo = new THREE.BoxGeometry(0.04, 0.4, 0.04);
                const strut = new THREE.Mesh(strutGeo, skidMat);
                strut.position.set(x, -0.5, z);
                this.group.add(strut);
            }
        }
    }

    // ============================================
    // 攻撃ヘリ
    // ============================================
    _buildAttackHeli() {
        const C = {
            body: 0x3B5B3B,
            bodyDark: 0x2B4B2B,
            cockpit: 0x88BBAA,
            metal: 0x4A4A4A,
            rotor: 0x3A3A3A,
            missile: 0x556B2F,
            accent: 0xCC3333,
        };

        // 胴体（やや細長い）
        const bodyGeo = new THREE.SphereGeometry(1.1, 12, 8);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: C.body, roughness: 0.5, metalness: 0.2
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.scale.set(1.5, 0.7, 0.7);
        body.castShadow = true;
        this.group.add(body);

        // コックピット
        const cockpitGeo = new THREE.SphereGeometry(0.5, 10, 8, 0, Math.PI);
        const cockpitMat = new THREE.MeshStandardMaterial({
            color: C.cockpit, roughness: 0.1, transparent: true, opacity: 0.6,
        });
        const cockpit = new THREE.Mesh(cockpitGeo, cockpitMat);
        cockpit.rotation.y = -Math.PI / 2;
        cockpit.position.set(0.9, -0.1, 0);
        this.group.add(cockpit);

        // テイルブーム
        const tailGeo = new THREE.CylinderGeometry(0.12, 0.2, 2.5, 8);
        const tailMat = new THREE.MeshStandardMaterial({ color: C.bodyDark, roughness: 0.6 });
        const tail = new THREE.Mesh(tailGeo, tailMat);
        tail.rotation.z = Math.PI / 2;
        tail.position.set(-2.0, 0.1, 0);
        this.group.add(tail);

        // テイルフィン（T字）
        const finGeo = new THREE.BoxGeometry(0.4, 0.6, 0.06);
        const finMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.5 });
        const fin = new THREE.Mesh(finGeo, finMat);
        fin.position.set(-3.0, 0.4, 0);
        this.group.add(fin);

        // 赤いストライプ
        const stripeGeo = new THREE.BoxGeometry(0.6, 0.06, 0.72);
        const stripeMat = new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.6 });
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.set(-0.5, 0, 0);
        this.group.add(stripe);

        // 反乱軍エンブレム: 側面の赤三角 ▽（Metal Slug Rebel ロゴ）
        const heliTriShape = new THREE.Shape();
        const htR = 0.22;
        heliTriShape.moveTo(-htR * 0.866, htR * 0.5);
        heliTriShape.lineTo(htR * 0.866, htR * 0.5);
        heliTriShape.lineTo(0, -htR);
        heliTriShape.closePath();
        const heliTriGeo = new THREE.ShapeGeometry(heliTriShape);
        const heliTriMat = new THREE.MeshStandardMaterial({
            color: C.accent, side: THREE.DoubleSide, roughness: 0.55,
            emissive: 0x331008, emissiveIntensity: 0.2,
        });
        const heliDiscMat = new THREE.MeshBasicMaterial({ color: 0xE8DEB4, side: THREE.DoubleSide });
        for (const z of [-0.62, 0.62]) {
            const disc = new THREE.Mesh(new THREE.CircleGeometry(0.30, 18), heliDiscMat);
            disc.position.set(-0.2, 0.05, z);
            disc.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(disc);
            const tri = new THREE.Mesh(heliTriGeo, heliTriMat);
            tri.position.set(-0.2, 0.05, z + (z > 0 ? 0.005 : -0.005));
            tri.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(tri);
        }

        // パイロット（コックピット内に上半身）
        const pilotGroup = new THREE.Group();
        pilotGroup.position.set(0.85, -0.05, 0);
        const pHelmet = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
            new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.5 })
        );
        pHelmet.position.y = 0.18;
        pHelmet.scale.set(1.05, 0.95, 1.0);
        pilotGroup.add(pHelmet);
        // バイザー（黒）
        const pVisor = new THREE.Mesh(
            new THREE.BoxGeometry(0.04, 0.06, 0.22),
            new THREE.MeshStandardMaterial({ color: 0x080810, metalness: 0.4, roughness: 0.2 })
        );
        pVisor.position.set(0.13, 0.16, 0);
        pilotGroup.add(pVisor);
        // 顔
        const pHead = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 10, 8),
            new THREE.MeshStandardMaterial({ color: 0xF0CCA0, roughness: 0.8 })
        );
        pHead.position.y = 0.10;
        pHead.scale.set(1.0, 0.95, 0.95);
        pilotGroup.add(pHead);
        // 体
        const pTorso = new THREE.Mesh(
            new THREE.BoxGeometry(0.18, 0.18, 0.22),
            new THREE.MeshStandardMaterial({ color: 0x4B5B3B, roughness: 0.8 })
        );
        pTorso.position.y = -0.05;
        pilotGroup.add(pTorso);
        this.group.add(pilotGroup);

        // 装甲プレート（胴体下の追加装甲、Metal Slug らしいゴテッと感）
        const armor = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 0.18, 1.1),
            new THREE.MeshStandardMaterial({ color: C.bodyDark, roughness: 0.65, metalness: 0.3 })
        );
        armor.position.set(0.1, -0.55, 0);
        this.group.add(armor);
        // 装甲のリベット
        const heliRivetMat = new THREE.MeshStandardMaterial({
            color: 0x95956E, metalness: 0.6, roughness: 0.4
        });
        for (const ax of [-0.55, -0.18, 0.18, 0.55]) {
            for (const az of [-0.45, 0.45]) {
                const rv = new THREE.Mesh(new THREE.SphereGeometry(0.03, 5, 4), heliRivetMat);
                rv.position.set(ax + 0.1, -0.46, az);
                this.group.add(rv);
            }
        }

        // メインローター（大型）
        this.mainRotor = new THREE.Group();
        const rotorMat = new THREE.MeshStandardMaterial({
            color: C.rotor, roughness: 0.3, metalness: 0.5
        });
        for (let i = 0; i < 4; i++) {
            const bladeGeo = new THREE.BoxGeometry(4.0, 0.04, 0.22);
            const blade = new THREE.Mesh(bladeGeo, rotorMat);
            blade.rotation.y = (Math.PI / 2) * i;
            this.mainRotor.add(blade);
        }
        this.mainRotor.position.y = 0.8;
        this.group.add(this.mainRotor);

        // 大型ローターブラーディスク
        const blurDisc = new THREE.Mesh(
            new THREE.CircleGeometry(2.1, 28),
            new THREE.MeshBasicMaterial({
                color: 0xC0C0C0, transparent: true, opacity: 0.22,
                depthWrite: false, side: THREE.DoubleSide,
            })
        );
        blurDisc.rotation.x = -Math.PI / 2;
        blurDisc.position.y = 0.83;
        this.group.add(blurDisc);

        // ローターハブ（大型）
        const hub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.15, 0.18, 0.22, 10),
            new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.6 })
        );
        hub.position.y = 0.78;
        this.group.add(hub);

        // テイルローター
        this.tailRotor = new THREE.Group();
        const tBladeGeo = new THREE.BoxGeometry(0.05, 1.0, 0.1);
        for (let i = 0; i < 2; i++) {
            const tb = new THREE.Mesh(tBladeGeo, rotorMat);
            tb.rotation.z = (Math.PI / 2) * i;
            this.tailRotor.add(tb);
        }
        this.tailRotor.position.set(-3.0, 0.4, 0.1);
        this.group.add(this.tailRotor);

        // 武装スタブウィング + ロケットポッド + ミサイル
        const pylonMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.5, metalness: 0.4 });
        const missileMat = new THREE.MeshStandardMaterial({ color: C.missile, roughness: 0.5 });
        const tipMat = new THREE.MeshStandardMaterial({ color: C.accent });
        for (let z of [-1.0, 1.0]) {
            // スタブウィング
            const stubWing = new THREE.Mesh(
                new THREE.BoxGeometry(0.7, 0.08, 0.4),
                new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.5, metalness: 0.3 })
            );
            stubWing.position.set(0, -0.2, z);
            this.group.add(stubWing);

            // パイロン
            const pylon = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.18, 0.08),
                pylonMat
            );
            pylon.position.set(0, -0.45, z);
            this.group.add(pylon);

            // ロケットポッド（円筒クラスター）
            const podBody = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.18, 0.55, 10),
                new THREE.MeshStandardMaterial({ color: C.bodyDark, roughness: 0.5, metalness: 0.4 })
            );
            podBody.rotation.z = Math.PI / 2;
            podBody.position.set(0.05, -0.62, z);
            this.group.add(podBody);
            // ポッド先端の穴（暗い円）
            const podFace = new THREE.Mesh(
                new THREE.CircleGeometry(0.16, 12),
                new THREE.MeshBasicMaterial({ color: 0x080808 })
            );
            podFace.position.set(0.34, -0.62, z);
            podFace.rotation.y = Math.PI / 2;
            this.group.add(podFace);
            // ロケット穴（7発分の小穴）
            for (let r = 0; r < 7; r++) {
                const ang = (r / 7) * Math.PI * 2;
                const hole = new THREE.Mesh(
                    new THREE.CircleGeometry(0.035, 6),
                    new THREE.MeshBasicMaterial({ color: 0x331810 })
                );
                hole.position.set(
                    0.345,
                    -0.62 + Math.cos(ang) * 0.1,
                    z + Math.sin(ang) * 0.1
                );
                hole.rotation.y = Math.PI / 2;
                this.group.add(hole);
            }

            // ミサイル（外側にもう一発）
            const missile = new THREE.Mesh(
                new THREE.CylinderGeometry(0.07, 0.07, 0.65, 8),
                missileMat
            );
            missile.rotation.z = Math.PI / 2;
            missile.position.set(0.05, -0.45, z + (z > 0 ? 0.25 : -0.25));
            this.group.add(missile);
            // 弾頭
            const tip = new THREE.Mesh(
                new THREE.ConeGeometry(0.07, 0.18, 8),
                tipMat
            );
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(0.45, -0.45, z + (z > 0 ? 0.25 : -0.25));
            this.group.add(tip);
        }

        // チンガンタレット（機首下の機銃マウント）
        const chinTurret = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({ color: C.bodyDark, roughness: 0.5, metalness: 0.4 })
        );
        chinTurret.rotation.x = Math.PI;
        chinTurret.position.set(1.4, -0.35, 0);
        this.group.add(chinTurret);
        const gunGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8);
        const gunMat = new THREE.MeshStandardMaterial({
            color: C.metal, roughness: 0.3, metalness: 0.7
        });
        const gun = new THREE.Mesh(gunGeo, gunMat);
        gun.rotation.z = Math.PI / 2;
        gun.position.set(1.85, -0.4, 0);
        this.group.add(gun);

        // エンジン排気口（後方両側、オレンジ発光）
        for (let z of [-0.4, 0.4]) {
            const exhaust = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.1, 0.18, 8),
                new THREE.MeshBasicMaterial({
                    color: 0xFFA040, transparent: true, opacity: 0.7,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                })
            );
            exhaust.rotation.z = Math.PI / 2;
            exhaust.position.set(-1.2, 0.35, z);
            this.group.add(exhaust);
        }
    }

    // ============================================
    // 爆撃機
    // ============================================
    _buildBomber() {
        const C = {
            body: 0x5A6A5A,
            wing: 0x4A5A4A,
            engine: 0x3A3A3A,
            cockpit: 0x88AACC,
            bomb: 0x333333,
        };

        // 胴体
        const bodyGeo = new THREE.CylinderGeometry(0.5, 0.4, 4.0, 10);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: C.body, roughness: 0.5, metalness: 0.15
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        this.group.add(body);

        // コックピット
        const cpGeo = new THREE.SphereGeometry(0.35, 8, 6);
        const cpMat = new THREE.MeshStandardMaterial({
            color: C.cockpit, transparent: true, opacity: 0.6, roughness: 0.1
        });
        const cp = new THREE.Mesh(cpGeo, cpMat);
        cp.position.set(1.8, 0.15, 0);
        this.group.add(cp);

        // 主翼
        const wingGeo = new THREE.BoxGeometry(1.5, 0.08, 6.0);
        const wingMat = new THREE.MeshStandardMaterial({ color: C.wing, roughness: 0.6 });
        const wing = new THREE.Mesh(wingGeo, wingMat);
        wing.position.set(-0.3, 0, 0);
        if (!this._lowShadow) wing.castShadow = true;
        this.group.add(wing);

        // 尾翼
        const hTailGeo = new THREE.BoxGeometry(0.5, 0.06, 2.0);
        const hTail = new THREE.Mesh(hTailGeo, wingMat);
        hTail.position.set(-1.8, 0, 0);
        this.group.add(hTail);

        const vTailGeo = new THREE.BoxGeometry(0.5, 1.0, 0.06);
        const vTail = new THREE.Mesh(vTailGeo, wingMat);
        vTail.position.set(-1.8, 0.5, 0);
        this.group.add(vTail);

        // エンジンナセル x 2
        for (let z of [-1.5, 1.5]) {
            const engGeo = new THREE.CylinderGeometry(0.22, 0.28, 0.9, 10);
            const engMat = new THREE.MeshStandardMaterial({
                color: C.engine, roughness: 0.4, metalness: 0.45
            });
            const eng = new THREE.Mesh(engGeo, engMat);
            eng.rotation.z = Math.PI / 2;
            eng.position.set(-0.1, -0.15, z);
            this.group.add(eng);

            // 排気管（オレンジ発光）
            const exhaust = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.06, 0.16, 8),
                new THREE.MeshBasicMaterial({
                    color: 0xFFA040, transparent: true, opacity: 0.6,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                })
            );
            exhaust.rotation.z = Math.PI / 2;
            exhaust.position.set(-0.62, -0.1, z + 0.18);
            this.group.add(exhaust);

            // プロペラ（回転用）
            const propGroup = new THREE.Group();
            const propGeo = new THREE.BoxGeometry(0.05, 1.4, 0.14);
            const propMat = new THREE.MeshStandardMaterial({ color: 0x2A2A2A });
            for (let pi = 0; pi < 3; pi++) {
                const p = new THREE.Mesh(propGeo, propMat);
                p.rotation.z = (Math.PI * 2 / 3) * pi;
                propGroup.add(p);
            }
            propGroup.position.set(0.4, -0.15, z);
            this.group.add(propGroup);

            // プロペラブラー
            const propBlur = new THREE.Mesh(
                new THREE.CircleGeometry(0.7, 18),
                new THREE.MeshBasicMaterial({
                    color: 0xCCCCCC, transparent: true, opacity: 0.18,
                    depthWrite: false, side: THREE.DoubleSide,
                })
            );
            propBlur.rotation.y = Math.PI / 2;
            propBlur.position.set(0.42, -0.15, z);
            this.group.add(propBlur);

            // スピナー
            const spinner = new THREE.Mesh(
                new THREE.ConeGeometry(0.1, 0.18, 8),
                new THREE.MeshStandardMaterial({ color: 0x4A4A4A, metalness: 0.5 })
            );
            spinner.rotation.z = -Math.PI / 2;
            spinner.position.set(0.5, -0.15, z);
            this.group.add(spinner);

            if (!this.mainRotor) this.mainRotor = propGroup;
            else this.tailRotor = propGroup;
        }

        // 爆弾ラック（胴体下）
        const bombMat = new THREE.MeshStandardMaterial({ color: C.bomb, roughness: 0.5, metalness: 0.3 });
        const finMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A, roughness: 0.6 });
        for (const z of [-0.4, 0.4]) {
            for (const x of [-0.6, 0.6]) {
                const bomb = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.09, 0.06, 0.55, 8),
                    bombMat
                );
                bomb.rotation.z = Math.PI / 2;
                bomb.position.set(x, -0.55, z);
                this.group.add(bomb);
                // 尾翼
                for (const fa of [0, Math.PI / 2]) {
                    const fin = new THREE.Mesh(
                        new THREE.BoxGeometry(0.18, 0.09, 0.02),
                        finMat
                    );
                    fin.position.set(x - 0.28, -0.55, z);
                    fin.rotation.x = fa;
                    this.group.add(fin);
                }
            }
        }

        // ノーズガラス
        const noseGlass = new THREE.Mesh(
            new THREE.SphereGeometry(0.45, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
            new THREE.MeshStandardMaterial({
                color: C.cockpit, transparent: true, opacity: 0.55, roughness: 0.1,
            })
        );
        noseGlass.rotation.z = -Math.PI / 2;
        noseGlass.position.set(2.05, 0, 0);
        this.group.add(noseGlass);
    }

    // ============================================
    // 戦闘機
    // ============================================
    _buildFighter() {
        const C = {
            body: 0x6A6A7A,
            wing: 0x5A5A6A,
            cockpit: 0x88CCDD,
            accent: 0xCC3333,
        };

        // 胴体（流線形）
        const bodyGeo = new THREE.CylinderGeometry(0.2, 0.35, 3.0, 8);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: C.body, roughness: 0.3, metalness: 0.4
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        this.group.add(body);

        // ノーズコーン
        const noseGeo = new THREE.ConeGeometry(0.2, 0.6, 8);
        const nose = new THREE.Mesh(noseGeo, bodyMat);
        nose.rotation.z = -Math.PI / 2;
        nose.position.x = 1.7;
        this.group.add(nose);

        // コックピット
        const cpGeo = new THREE.SphereGeometry(0.22, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.6);
        const cpMat = new THREE.MeshStandardMaterial({
            color: C.cockpit, transparent: true, opacity: 0.6
        });
        const cp = new THREE.Mesh(cpGeo, cpMat);
        cp.position.set(0.5, 0.2, 0);
        this.group.add(cp);

        // デルタ翼
        const wingShape = new THREE.Shape();
        wingShape.moveTo(0, 0);
        wingShape.lineTo(-1.2, 2.5);
        wingShape.lineTo(-0.8, 0);
        wingShape.lineTo(0, 0);

        const wingExtSettings = { depth: 0.04, bevelEnabled: false };
        const wingGeo = new THREE.ExtrudeGeometry(wingShape, wingExtSettings);
        const wingMat = new THREE.MeshStandardMaterial({ color: C.wing, roughness: 0.4 });

        for (let side of [-1, 1]) {
            const wing = new THREE.Mesh(wingGeo, wingMat);
            wing.rotation.x = side > 0 ? 0 : Math.PI;
            wing.position.set(0, 0, side * 0.02);
            if (!this._lowShadow) wing.castShadow = true;
            this.group.add(wing);
        }

        // 尾翼
        const vTailGeo = new THREE.BoxGeometry(0.6, 0.8, 0.04);
        const vTail = new THREE.Mesh(vTailGeo, wingMat);
        vTail.position.set(-1.3, 0.45, 0);
        this.group.add(vTail);

        // 赤いストライプ
        const stripeGeo = new THREE.BoxGeometry(0.8, 0.04, 0.36);
        const stripeMat = new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.5 });
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.set(0.3, 0, 0);
        this.group.add(stripe);

        // ジェット排気（後方の青/オレンジ発光）
        const jetCore = new THREE.Mesh(
            new THREE.CylinderGeometry(0.16, 0.1, 0.3, 12),
            new THREE.MeshBasicMaterial({ color: 0xFFAA40, transparent: true, opacity: 0.85,
                blending: THREE.AdditiveBlending, depthWrite: false })
        );
        jetCore.rotation.z = Math.PI / 2;
        jetCore.position.set(-1.6, 0, 0);
        this.group.add(jetCore);
        this.jetCore = jetCore;

        const jetCone = new THREE.Mesh(
            new THREE.ConeGeometry(0.18, 1.4, 12, 1, true),
            new THREE.MeshBasicMaterial({ color: 0x66CCFF, transparent: true, opacity: 0.5,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
        );
        jetCone.rotation.z = Math.PI / 2;
        jetCone.position.set(-2.4, 0, 0);
        this.group.add(jetCone);

        // 排気ノズル（金属環）
        const nozzle = new THREE.Mesh(
            new THREE.TorusGeometry(0.18, 0.04, 6, 14),
            new THREE.MeshStandardMaterial({ color: 0x2A2A30, metalness: 0.7, roughness: 0.3 })
        );
        nozzle.rotation.y = Math.PI / 2;
        nozzle.position.set(-1.5, 0, 0);
        this.group.add(nozzle);

        // インテーク（機首両側）
        for (let z of [-0.25, 0.25]) {
            const intake = new THREE.Mesh(
                new THREE.CylinderGeometry(0.13, 0.15, 0.4, 10),
                new THREE.MeshStandardMaterial({ color: 0x080808 })
            );
            intake.rotation.z = Math.PI / 2;
            intake.position.set(0.3, -0.15, z);
            this.group.add(intake);
        }

        // 翼下のミサイル（ハードポイント x 2）
        const missileMat = new THREE.MeshStandardMaterial({ color: 0xCCCCCC, roughness: 0.4, metalness: 0.5 });
        const tipMat = new THREE.MeshStandardMaterial({ color: 0xCC2020 });
        for (const z of [-1.1, 1.1]) {
            const missile = new THREE.Mesh(
                new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8),
                missileMat
            );
            missile.rotation.z = Math.PI / 2;
            missile.position.set(-0.3, -0.18, z);
            this.group.add(missile);
            const tip = new THREE.Mesh(
                new THREE.ConeGeometry(0.06, 0.18, 8),
                tipMat
            );
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(0.13, -0.18, z);
            this.group.add(tip);
            // 尾翼
            const fin = new THREE.Mesh(
                new THREE.BoxGeometry(0.16, 0.1, 0.02),
                new THREE.MeshStandardMaterial({ color: 0x666666 })
            );
            fin.position.set(-0.6, -0.18, z);
            this.group.add(fin);
        }

        // ダミーのローター（プロペラなし、互換性のため）
        this.mainRotor = null;
        this.tailRotor = null;
    }

    // ============================================
    // レイザードローン
    // ============================================
    _buildDrone() {
        const C = {
            shell: 0x2E3D45,
            plate: 0x485C62,
            dark: 0x11171A,
            lens: 0x55D6FF,
            accent: 0xFF5A38,
        };

        const body = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 14, 10),
            new THREE.MeshStandardMaterial({ color: C.shell, roughness: 0.42, metalness: 0.45 })
        );
        body.scale.set(1.18, 0.72, 1.0);
        body.castShadow = true;
        this.group.add(body);

        const eye = new THREE.Mesh(
            new THREE.SphereGeometry(0.16, 10, 8),
            new THREE.MeshBasicMaterial({ color: C.lens })
        );
        eye.position.set(0.52, 0.02, 0);
        eye.scale.set(0.55, 0.85, 1.0);
        this.group.add(eye);

        const plateMat = new THREE.MeshStandardMaterial({ color: C.plate, roughness: 0.5, metalness: 0.38 });
        for (const z of [-0.42, 0.42]) {
            const plate = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.18), plateMat);
            plate.position.set(-0.04, 0.35, z);
            plate.rotation.x = z > 0 ? -0.18 : 0.18;
            this.group.add(plate);
        }

        const rotorMat = new THREE.MeshStandardMaterial({ color: C.dark, roughness: 0.35, metalness: 0.55 });
        const ringMat = new THREE.MeshStandardMaterial({ color: C.plate, roughness: 0.4, metalness: 0.5 });
        for (const x of [-0.38, 0.38]) {
            for (const z of [-0.62, 0.62]) {
                const duct = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 6, 14), ringMat);
                duct.position.set(x, 0.02, z);
                duct.rotation.x = Math.PI / 2;
                this.group.add(duct);

                const rotor = new THREE.Group();
                rotor.position.copy(duct.position);
                this.group.add(rotor);
                for (let i = 0; i < 3; i++) {
                    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.025, 0.055), rotorMat);
                    blade.rotation.y = i * Math.PI * 2 / 3;
                    rotor.add(blade);
                }
                this.extraRotors.push(rotor);
            }
        }

        const gun = new THREE.Mesh(
            new THREE.CylinderGeometry(0.035, 0.04, 0.52, 8),
            new THREE.MeshStandardMaterial({ color: C.dark, roughness: 0.35, metalness: 0.7 })
        );
        gun.rotation.z = Math.PI / 2;
        gun.position.set(0.72, -0.18, 0);
        this.group.add(gun);

        const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 4), new THREE.MeshBasicMaterial({ color: C.accent }));
        beacon.position.set(-0.48, 0.26, 0);
        this.group.add(beacon);
    }

    // ============================================
    // 高速迎撃機
    // ============================================
    _buildInterceptor() {
        const C = {
            body: 0x3E4654,
            wing: 0x29313D,
            cockpit: 0x65C8E8,
            accent: 0xE04A24,
            metal: 0x161A20,
        };

        const bodyMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.28, metalness: 0.5 });
        const wingMat = new THREE.MeshStandardMaterial({ color: C.wing, roughness: 0.38, metalness: 0.38 });

        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.34, 3.5, 10), bodyMat);
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        this.group.add(body);

        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.23, 0.72, 10), bodyMat);
        nose.rotation.z = -Math.PI / 2;
        nose.position.x = 2.1;
        this.group.add(nose);

        const cockpit = new THREE.Mesh(
            new THREE.SphereGeometry(0.26, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.58),
            new THREE.MeshStandardMaterial({ color: C.cockpit, transparent: true, opacity: 0.68, roughness: 0.12, metalness: 0.12 })
        );
        cockpit.position.set(0.65, 0.22, 0);
        cockpit.scale.set(1.1, 0.75, 0.9);
        this.group.add(cockpit);

        for (const z of [-1, 1]) {
            const wing = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.06, 1.75), wingMat);
            wing.position.set(-0.15, -0.02, z * 0.88);
            wing.rotation.y = z * 0.36;
            wing.rotation.z = -0.08;
            this.group.add(wing);

            const canard = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.045, 0.65), wingMat);
            canard.position.set(1.05, 0.02, z * 0.45);
            canard.rotation.y = z * -0.32;
            this.group.add(canard);

            const missile = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 8), new THREE.MeshStandardMaterial({ color: 0xD5D5CE, roughness: 0.38, metalness: 0.45 }));
            missile.rotation.z = Math.PI / 2;
            missile.position.set(-0.30, -0.18, z * 1.45);
            this.group.add(missile);
        }

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.84, 0.06), wingMat);
        tail.position.set(-1.45, 0.42, 0);
        tail.rotation.z = -0.1;
        this.group.add(tail);

        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.04, 0.40), new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.46 }));
        stripe.position.set(0.20, 0.03, 0);
        this.group.add(stripe);

        for (const z of [-0.18, 0.18]) {
            const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, 0.45, 10), new THREE.MeshBasicMaterial({ color: C.metal }));
            intake.rotation.z = Math.PI / 2;
            intake.position.set(0.10, -0.16, z);
            this.group.add(intake);
        }

        const jetCore = new THREE.Mesh(
            new THREE.CylinderGeometry(0.18, 0.12, 0.32, 12),
            new THREE.MeshBasicMaterial({ color: 0xFF7A2A, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending, depthWrite: false })
        );
        jetCore.rotation.z = Math.PI / 2;
        jetCore.position.set(-1.85, 0, 0);
        this.group.add(jetCore);
        this.jetCore = jetCore;

        const jetCone = new THREE.Mesh(
            new THREE.ConeGeometry(0.20, 1.55, 12, 1, true),
            new THREE.MeshBasicMaterial({ color: 0x58D8FF, transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
        );
        jetCone.rotation.z = Math.PI / 2;
        jetCone.position.set(-2.58, 0, 0);
        this.group.add(jetCone);
    }

    // ============================================
    // 重装ガンシップ
    // ============================================
    _buildGunship() {
        const C = {
            body: 0x445246,
            bodyDark: 0x252D27,
            armor: 0x66715F,
            cockpit: 0x8CCEE0,
            metal: 0x2B3030,
            accent: 0xD83A24,
            missile: 0x676345,
        };

        const bodyMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.46, metalness: 0.28 });
        const armorMat = new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.54, metalness: 0.34 });
        const metalMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.34, metalness: 0.68 });

        const fuselage = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 10), bodyMat);
        fuselage.scale.set(2.2, 0.72, 0.92);
        fuselage.castShadow = true;
        this.group.add(fuselage);

        const cockpit = new THREE.Mesh(
            new THREE.SphereGeometry(0.62, 12, 8, 0, Math.PI),
            new THREE.MeshStandardMaterial({ color: C.cockpit, roughness: 0.08, metalness: 0.12, transparent: true, opacity: 0.62 })
        );
        cockpit.rotation.y = -Math.PI / 2;
        cockpit.position.set(1.72, 0.12, 0);
        cockpit.scale.set(0.9, 0.65, 0.95);
        this.group.add(cockpit);

        const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 2.2, 8), bodyMat);
        tail.rotation.z = Math.PI / 2;
        tail.position.set(-2.35, 0.10, 0);
        this.group.add(tail);

        for (const z of [-0.92, 0.92]) {
            const stub = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.12, 0.42), armorMat);
            stub.position.set(0.20, -0.16, z);
            this.group.add(stub);

            const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.72, 10), metalMat);
            pod.rotation.z = Math.PI / 2;
            pod.position.set(0.34, -0.48, z);
            this.group.add(pod);
            const face = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), new THREE.MeshBasicMaterial({ color: 0x070707 }));
            face.position.set(0.72, -0.48, z);
            face.rotation.y = Math.PI / 2;
            this.group.add(face);

            for (const dz of [-0.20, 0.20]) {
                const missile = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.68, 8), new THREE.MeshStandardMaterial({ color: C.missile, roughness: 0.46 }));
                missile.rotation.z = Math.PI / 2;
                missile.position.set(-0.25, -0.34, z + dz);
                this.group.add(missile);
            }
        }

        const rotorMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.32, metalness: 0.58 });
        for (const x of [-0.8, 0.8]) {
            const rotor = new THREE.Group();
            rotor.position.set(x, 0.88, 0);
            this.group.add(rotor);
            for (let i = 0; i < 4; i++) {
                const blade = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.045, 0.20), rotorMat);
                blade.rotation.y = i * Math.PI / 2;
                rotor.add(blade);
            }
            const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.16, 10), metalMat);
            hub.position.y = 0.01;
            rotor.add(hub);
            if (!this.mainRotor) this.mainRotor = rotor;
            else this.extraRotors.push(rotor);
        }

        this.tailRotor = new THREE.Group();
        this.tailRotor.position.set(-3.30, 0.34, 0.08);
        this.group.add(this.tailRotor);
        for (let i = 0; i < 2; i++) {
            const tb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.12), rotorMat);
            tb.rotation.z = i * Math.PI / 2;
            this.tailRotor.add(tb);
        }

        const chin = new THREE.Mesh(new THREE.SphereGeometry(0.24, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), metalMat);
        chin.rotation.x = Math.PI;
        chin.position.set(1.28, -0.48, 0);
        this.group.add(chin);
        for (const z of [-0.06, 0.06]) {
            const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.042, 0.78, 8), metalMat);
            gun.rotation.z = Math.PI / 2;
            gun.position.set(1.78, -0.52, z);
            this.group.add(gun);
        }

        for (const x of [-0.55, 0.1, 0.75]) {
            const armor = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 1.55), armorMat);
            armor.position.set(x, -0.58, 0);
            this.group.add(armor);
        }

        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.06, 1.08), new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.55 }));
        stripe.position.set(-0.22, 0.08, 0);
        this.group.add(stripe);
    }

    // ============================================
    // 更新
    // ============================================
    update(dt, playerPos, elapsedTime) {
        if (!this.alive) return;
        super.update(dt, playerPos, elapsedTime);

        // ローター回転
        this.rotorAngle += dt * 35;
        if (this.mainRotor) this.mainRotor.rotation.y = this.rotorAngle;
        if (this.tailRotor) this.tailRotor.rotation.z = this.rotorAngle * 1.5;
        if (this.extraRotors && this.extraRotors.length) {
            this.extraRotors.forEach((r, idx) => {
                r.rotation.y = this.rotorAngle * (idx % 2 === 0 ? 1 : -1);
            });
        }

        // ジェット排気フリッカー（fighter専用）
        if (this.jetCore) {
            this.jetCore.material.opacity = 0.7 + Math.sin(elapsedTime * 30) * 0.15 + (Math.random() - 0.5) * 0.1;
        }

        this.aiTimer += dt;

        switch (this.subType) {
            case 'scout_heli':
                this._aiScoutHeli(dt, playerPos, elapsedTime);
                break;
            case 'attack_heli':
                this._aiAttackHeli(dt, playerPos, elapsedTime);
                break;
            case 'bomber':
                this._aiBomber(dt, playerPos, elapsedTime);
                break;
            case 'fighter':
                this._aiFighter(dt, playerPos, elapsedTime);
                break;
            case 'drone':
                this._aiDrone(dt, playerPos, elapsedTime);
                break;
            case 'interceptor':
                this._aiInterceptor(dt, playerPos, elapsedTime);
                break;
            case 'gunship':
                this._aiGunship(dt, playerPos, elapsedTime);
                break;
            case 'tomahawk':
                this._aiTomahawk(dt, playerPos, elapsedTime);
                break;
            case 'heavy_heli':
                this._aiHeavyHeli(dt, playerPos, elapsedTime);
                break;
            case 'combat_drone':
                this._aiCombatDrone(dt, playerPos, elapsedTime);
                break;
        }
    }

    /**
     * 偵察ヘリ: プレイヤー真上付近を旋回（射程内）しながら機銃
     */
    _aiScoutHeli(dt, playerPos, elapsed) {
        this.orbitAngle += dt * 1.2;
        // 軌道半径を狭くして、旋回中は常にプレイヤーの射程を通るようにする
        const r = Math.min(this.orbitRadius, 12);
        const targetX = playerPos.x + Math.cos(this.orbitAngle) * r;
        const targetZ = playerPos.z + Math.sin(this.orbitAngle) * r;

        this.group.position.x += (targetX - this.group.position.x) * dt * 2;
        this.group.position.z += (targetZ - this.group.position.z) * dt * 2;
        this.group.position.y += (this.flightHeight - this.group.position.y) * dt * 2;

        // プレイヤー方向を向く（モデルのローカル +X = 機首）
        const dir = new THREE.Vector3().subVectors(playerPos, this.group.position);
        dir.y = 0;
        if (dir.lengthSq() > 0.1) {
            const angle = Math.atan2(-dir.z, dir.x);
            this.group.rotation.y = angle;
        }

        // 傾きの演出
        this.group.rotation.z = Math.sin(this.orbitAngle) * 0.15;

        this._fire(playerPos, elapsed);
    }

    /**
     * 攻撃ヘリ: ホバリング→ミサイル→移動
     */
    _aiAttackHeli(dt, playerPos, elapsed) {
        const phases = [
            { duration: 3, action: 'approach' },
            { duration: 2, action: 'hover_fire' },
            { duration: 2, action: 'strafe' },
        ];

        const phase = phases[this.aiPhase % phases.length];

        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
        }

        const dir = new THREE.Vector3().subVectors(playerPos, this.group.position);
        dir.y = 0;
        if (dir.lengthSq() > 0.1) {
            const angle = Math.atan2(-dir.z, dir.x);
            this.group.rotation.y = angle;
        }

        switch (phase.action) {
            case 'approach': {
                const target = playerPos.clone();
                target.y = this.flightHeight;
                const moveDir = new THREE.Vector3().subVectors(target, this.group.position);
                if (moveDir.length() > 12) {
                    moveDir.normalize().multiplyScalar(this.speed * dt);
                    this.group.position.add(moveDir);
                }
                this.group.rotation.x = -0.1; // 前傾
                break;
            }
            case 'hover_fire':
                this.group.rotation.x *= 0.95; // 水平に戻る
                this.group.position.y += (this.flightHeight - this.group.position.y) * dt * 3;
                // ミサイル発射
                this._fireRocket(playerPos, elapsed);
                break;
            case 'strafe': {
                // プレイヤーの X 軸を横切るストレーフラン
                const strafeDir = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
                // プレイヤーの反対側へ横切るように entryDir を強制設定
                const crossSign = this.group.position.x < playerPos.x ? 1 : -1;
                this.group.position.add(strafeDir.multiplyScalar(this.speed * 1.5 * dt * crossSign));
                this.group.rotation.z = 0.2 * crossSign;
                this._fire(playerPos, elapsed);
                break;
            }
        }
    }

    /**
     * 爆撃機: 画面端から直線飛行、爆弾投下
     */
    _aiBomber(dt, playerPos, elapsed) {
        // プレイヤー方向へ向かって直線飛行（射程を必ず通過）
        if (this.entryDir === undefined || this._bomberDirSet === undefined) {
            // 進行方向を、現在位置からプレイヤーを通り過ぎる方向に固定
            this.entryDir = this.group.position.x < playerPos.x ? 1 : -1;
            this._bomberDirSet = true;
        }
        // X 軸移動 + プレイヤー Z へのゆるい追従（射程に入れるため）
        this.group.position.x += this.speed * dt * this.entryDir;
        const dz = playerPos.z - this.group.position.z;
        this.group.position.z += Math.sign(dz) * Math.min(Math.abs(dz), this.speed * 0.4 * dt);

        // プレイヤー上空通過時に爆弾投下
        const dx = Math.abs(this.group.position.x - playerPos.x);
        if (dx < 3 && this.aiTimer > 1.0) {
            this._dropBomb(elapsed);
            this.aiTimer = 0;
        }

        // プレイヤー反対側に十分離れたら消滅
        const passedBy = (this.entryDir > 0 && this.group.position.x > playerPos.x + 40)
            || (this.entryDir < 0 && this.group.position.x < playerPos.x - 40);
        if (passedBy) this.alive = false;
    }

    /**
     * 戦闘機: 急降下→射撃→離脱を繰り返す
     */
    _aiFighter(dt, playerPos, elapsed) {
        const phases = [
            { duration: 2, action: 'circle' },
            { duration: 1.5, action: 'dive' },
            { duration: 2, action: 'climb' },
        ];

        const phase = phases[this.aiPhase % phases.length];

        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            this.burstCount = 0;
        }

        switch (phase.action) {
            case 'circle':
                this.orbitAngle += dt * 2;
                this.group.position.x = playerPos.x + Math.cos(this.orbitAngle) * 25;
                this.group.position.z = playerPos.z + Math.sin(this.orbitAngle) * 25;
                this.group.position.y += (this.flightHeight + 1.5 - this.group.position.y) * dt * 3;

                this.group.rotation.z = -Math.sin(this.orbitAngle * 2) * 0.3;
                break;

            case 'dive': {
                const target = playerPos.clone();
                target.y = 2;
                const moveDir = new THREE.Vector3().subVectors(target, this.group.position);
                moveDir.normalize().multiplyScalar(this.speed * 1.5 * dt);
                this.group.position.add(moveDir);

                // 急降下中に連射
                if (this.burstCount < 5) {
                    this._fire(playerPos, elapsed);
                    this.burstCount++;
                }

                this.group.rotation.x = -0.4; // 急降下姿勢
                break;
            }

            case 'climb':
                this.group.position.y += this.speed * dt;
                this.group.position.x += this.speed * 0.5 * dt * this.entryDir;
                this.group.rotation.x = 0.3; // 上昇姿勢
                break;
        }

        // 方向を向く（モデルのローカル +X = 機首）
        const vel = new THREE.Vector3(
            this.entryDir, 0, 0
        );
        if (vel.lengthSq() > 0) {
            const angle = Math.atan2(-vel.z, vel.x);
            this.group.rotation.y = angle;
        }
    }

    /**
     * レイザードローン: 近距離を周回し、短い直線突進を混ぜる。
     */
    _aiDrone(dt, playerPos, elapsed) {
        const phases = [
            { duration: 2.4, action: 'orbit' },
            { duration: 0.9, action: 'slash' },
            { duration: 1.2, action: 'reform' },
        ];
        const phase = phases[this.aiPhase % phases.length];
        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            this.entryDir = Math.random() > 0.5 ? 1 : -1;
        }

        const prev = this.group.position.clone();
        this.orbitAngle += dt * (2.2 + this.aiPhase * 0.05) * this.entryDir;

        if (phase.action === 'orbit') {
            const r = 7.0 + Math.sin(this.orbitAngle * 1.7) * 2.0;
            const target = new THREE.Vector3(
                playerPos.x + Math.cos(this.orbitAngle) * r,
                this.flightHeight + Math.sin(this.orbitAngle * 1.3) * 0.6,
                playerPos.z + Math.sin(this.orbitAngle) * r
            );
            this.group.position.lerp(target, Math.min(1, dt * 3.0));
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'slash') {
            const target = playerPos.clone();
            target.x += this.entryDir * 9.5;
            target.z += Math.sin(this.orbitAngle) * 4.0;
            target.y = this.flightHeight - 0.8;
            const move = target.sub(this.group.position);
            if (move.lengthSq() > 0.01) this.group.position.add(move.normalize().multiplyScalar(this.speed * 1.35 * dt));
            this._fire(playerPos, elapsed);
        } else {
            const target = playerPos.clone();
            target.x -= this.entryDir * 11.0;
            target.z += 8.0;
            target.y = this.flightHeight + 0.5;
            this.group.position.lerp(target, Math.min(1, dt * 2.2));
        }

        const vel = this.group.position.clone().sub(prev);
        if (vel.lengthSq() > 0.0001) {
            const angle = Math.atan2(-vel.z, vel.x);
            this.group.rotation.y = angle;
            this.group.rotation.z = THREE.MathUtils.clamp(-vel.x * 0.2, -0.32, 0.32);
        }
    }

    /**
     * 高速迎撃機: 斜め突入、反転、再突入を繰り返す。
     */
    _aiInterceptor(dt, playerPos, elapsed) {
        const phases = [
            { duration: 1.25, action: 'slash' },
            { duration: 0.75, action: 'break' },
            { duration: 1.10, action: 'reengage' },
        ];
        const phase = phases[this.aiPhase % phases.length];
        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            if (phase.action === 'reengage') this.entryDir *= -1;
        }

        const prev = this.group.position.clone();
        let target;
        if (phase.action === 'slash') {
            target = playerPos.clone();
            target.x += this.entryDir * -13.5;
            target.z += Math.sin(elapsed * 2.4) * 5.5;
            target.y = this.flightHeight - 1.0;
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'break') {
            target = playerPos.clone();
            target.x += this.entryDir * 18.0;
            target.z += 12.0;
            target.y = this.flightHeight + 2.0;
        } else {
            target = playerPos.clone();
            target.x += this.entryDir * 15.0;
            target.z -= 6.0;
            target.y = this.flightHeight + 0.8;
            if (this.aiTimer > 0.45) this._fire(playerPos, elapsed);
        }

        const move = target.sub(this.group.position);
        if (move.lengthSq() > 0.01) {
            const speedScale = phase.action === 'slash' ? 1.65 : 1.15;
            this.group.position.add(move.normalize().multiplyScalar(this.speed * speedScale * dt));
        }

        const vel = this.group.position.clone().sub(prev);
        if (vel.lengthSq() > 0.0001) {
            const angle = Math.atan2(-vel.z, vel.x);
            this.group.rotation.y = angle;
            this.group.rotation.x = phase.action === 'slash' ? -0.22 : 0.18;
            this.group.rotation.z = THREE.MathUtils.clamp(-vel.x * 0.16, -0.42, 0.42);
        }
    }

    /**
     * 重装ガンシップ: ホバー砲撃、横移動、爆撃を組み合わせる。
     */
    _aiGunship(dt, playerPos, elapsed) {
        const phases = [
            { duration: 2.8, action: 'approach' },
            { duration: 2.6, action: 'barrage' },
            { duration: 2.2, action: 'broadside' },
            { duration: 1.4, action: 'relocate' },
        ];
        const phase = phases[this.aiPhase % phases.length];
        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            this.entryDir = Math.random() > 0.5 ? 1 : -1;
        }

        const dir = new THREE.Vector3().subVectors(playerPos, this.group.position);
        dir.y = 0;
        if (dir.lengthSq() > 0.1) {
            this.group.rotation.y = Math.atan2(-dir.z, dir.x);
        }

        if (phase.action === 'approach') {
            const target = playerPos.clone();
            target.x += this.entryDir * 7.0;
            target.z += 12.0;
            target.y = this.flightHeight;
            this.group.position.lerp(target, Math.min(1, dt * 1.55));
            this.group.rotation.x = -0.08;
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'barrage') {
            this.group.position.y += (this.flightHeight - this.group.position.y) * dt * 2.4;
            this.group.position.x += Math.sin(elapsed * 1.4) * dt * 2.0;
            this._fireRocket(playerPos, elapsed);
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'broadside') {
            const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
            this.group.position.add(side.multiplyScalar(this.entryDir * this.speed * 1.25 * dt));
            this.group.position.z += Math.sin(elapsed * 2.0) * dt * 1.2;
            this._fire(playerPos, elapsed);
            if (Math.abs(this.group.position.x - playerPos.x) < 8.0 && this.aiTimer > 0.45) {
                this._dropGunshipBomb(elapsed);
            }
        } else {
            const target = playerPos.clone();
            target.x -= this.entryDir * 12.0;
            target.z += 16.0;
            target.y = this.flightHeight + 0.8;
            this.group.position.lerp(target, Math.min(1, dt * 2.0));
            this.group.rotation.x = 0.12;
        }

        this.group.rotation.z = Math.sin(elapsed * 2.4) * 0.08;
    }

    _aiTomahawk(dt, playerPos, elapsed) {
        const target = playerPos.clone();
        target.y += 1.0;
        const toTarget = target.sub(this.group.position);
        const distance = toTarget.length();
        if (distance < 0.001) return;

        const desiredDir = toTarget.normalize();
        desiredDir.y = THREE.MathUtils.clamp(desiredDir.y, -0.2, 0.28);
        desiredDir.normalize();

        if (!this.homingDir) {
            this.homingDir = desiredDir.clone();
        } else {
            const turnRate = THREE.MathUtils.clamp(2.2 + dt * 2, 0, 1);
            this.homingDir.lerp(desiredDir, turnRate * dt * 3.6).normalize();
        }

        // 蛇行しすぎない程度に横揺れして、巡航ミサイルらしい軌道にする
        const sideWave = Math.sin(elapsed * 8 + this.orbitAngle) * 0.02;
        this.group.position.addScaledVector(this.homingDir, this.speed * dt);
        this.group.position.x += sideWave * (this.entryDir > 0 ? 1 : -1);
        this.group.position.y = Math.max(0.9, this.group.position.y);

        const lookAt = this.group.position.clone().add(this.homingDir);
        this.group.lookAt(lookAt);
        this.group.rotation.z += sideWave * 2.5;
    }

    _fireRocket(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < this.fireRate) return;
        this.lastFireTime = elapsed;

        const pos = this.group.position.clone();
        const dir = new THREE.Vector3().subVectors(playerPos, pos);
        dir.normalize();

        for (let offset of [-0.5, 0.5]) {
            const rocketPos = pos.clone();
            rocketPos.z += offset;

            const rocket = new Projectile(this.scene, {
                position: rocketPos,
                direction: dir.clone(),
                speed: 15,
                damage: this.damage,
                owner: 'enemy',
                type: 'rocket',
                maxDistance: 60,
            });
            this.projectiles.push(rocket);
        }
    }

    _dropBomb(elapsed) {
        if (elapsed - this.lastFireTime < 0.8) return;
        this.lastFireTime = elapsed;

        const pos = this.group.position.clone();
        const dir = new THREE.Vector3(0, -1, 0);

        const bomb = new Projectile(this.scene, {
            position: pos,
            direction: dir,
            speed: 2,
            damage: this.damage,
            owner: 'enemy',
            type: 'bomb',
            maxDistance: 50,
            gravity: 15,
        });
        this.projectiles.push(bomb);
    }

    _dropGunshipBomb(elapsed) {
        if (elapsed - (this.lastBombTime || 0) < 1.05) return;
        this.lastBombTime = elapsed;

        for (const z of [-0.42, 0.42]) {
            const pos = this.group.position.clone();
            pos.z += z;
            const bomb = new Projectile(this.scene, {
                position: pos,
                direction: new THREE.Vector3(0, -1, 0),
                speed: 2.2,
                damage: this.damage + 4,
                owner: 'enemy',
                type: 'bomb',
                maxDistance: 50,
                gravity: 16,
            });
            this.projectiles.push(bomb);
        }
    }

    // ============================================
    // 大型輸送ヘリ (Heavy Heli)
    //  二重タンデムローター（Chinook風）+ 側面ドアガナー + 翼端ロケットポッド。
    //  Wave 30+ 中東市街地ステージ用の大型機。装甲が厚く HP 高めで、
    //  低空ホバリングからロケット斉射＋ドアガナー乱射で制圧してくる。
    // ============================================
    _buildHeavyHeli() {
        const C = {
            body:    0x6E7240,  // デザートタン
            bodyDk:  0x4A4C28,
            armor:   0x8A8C5A,
            metal:   0x393A30,
            cockpit: 0x9CC8B8,
            accent:  0xC83018,  // 反乱軍の赤
            rotor:   0x1E1E1A,
            missile: 0x5E6234,
        };

        const bodyMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.6, metalness: 0.25 });
        const armorMat = new THREE.MeshStandardMaterial({ color: C.armor, roughness: 0.55, metalness: 0.32 });
        const metalMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.6 });
        const rotorMat = new THREE.MeshStandardMaterial({ color: C.rotor, roughness: 0.36, metalness: 0.55 });

        // 巨大胴体（角ばった輸送型）
        const fuselage = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.7, 1.7), bodyMat);
        fuselage.position.y = 0;
        fuselage.castShadow = true;
        this.group.add(fuselage);

        // 機首コックピットセクション（傾斜）
        const noseLow = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.5, 1.6), bodyMat);
        noseLow.position.set(2.95, -0.08, 0);
        this.group.add(noseLow);
        const noseSlope = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.0, 1.55), bodyMat);
        noseSlope.position.set(3.45, 0.35, 0);
        noseSlope.rotation.z = -0.32;
        this.group.add(noseSlope);

        // コックピット窓（二段）
        const cockpitMat = new THREE.MeshStandardMaterial({
            color: C.cockpit, transparent: true, opacity: 0.65,
            roughness: 0.12, metalness: 0.15, emissive: 0x081414, emissiveIntensity: 0.2,
        });
        const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.55, 1.42), cockpitMat);
        cockpit.position.set(3.62, 0.45, 0);
        cockpit.rotation.z = -0.3;
        this.group.add(cockpit);
        // サイド窓のフレーム
        for (const z of [-0.78, 0.78]) {
            const sideWin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.04), cockpitMat);
            sideWin.position.set(3.55, 0.40, z);
            sideWin.rotation.z = -0.3;
            this.group.add(sideWin);
        }

        // 後部ランプ（傾斜した搬入扉）
        const rampSlope = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.55), bodyMat);
        rampSlope.position.set(-3.05, -0.18, 0);
        rampSlope.rotation.z = 0.32;
        this.group.add(rampSlope);
        const rampFace = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.3, 1.5), armorMat);
        rampFace.position.set(-3.55, -0.25, 0);
        rampFace.rotation.z = 0.32;
        this.group.add(rampFace);

        // 側面ドア（左右の搬入扉、開いた状態を表現）
        for (const z of [-0.88, 0.88]) {
            const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 0.08), armorMat);
            doorFrame.position.set(0.4, -0.1, z);
            this.group.add(doorFrame);
            // ドアガナー（黒い人影 + 機銃）
            const gunner = new THREE.Mesh(
                new THREE.BoxGeometry(0.34, 0.6, 0.34),
                new THREE.MeshStandardMaterial({ color: 0x2A2E20, roughness: 0.7 })
            );
            gunner.position.set(0.4, 0.18, z * 1.05);
            this.group.add(gunner);
            // ドアマウント機銃（M134風）
            const dGun = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.95, 8), metalMat);
            dGun.rotation.x = Math.PI / 2;
            dGun.position.set(0.55, -0.05, z * 1.32);
            this.group.add(dGun);
            const dMag = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.18), metalMat);
            dMag.position.set(0.55, -0.18, z * 1.18);
            this.group.add(dMag);
        }

        // 胴体下の装甲スカート
        const skirt = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.32, 1.95), armorMat);
        skirt.position.set(-0.1, -0.95, 0);
        this.group.add(skirt);
        // リベット列
        const rivetMat = new THREE.MeshStandardMaterial({ color: 0x96926A, metalness: 0.6, roughness: 0.4 });
        for (let rx = -2.4; rx <= 2.4; rx += 0.5) {
            for (const rz of [-0.92, 0.92]) {
                const rv = new THREE.Mesh(new THREE.SphereGeometry(0.04, 5, 4), rivetMat);
                rv.position.set(rx, -0.85, rz);
                this.group.add(rv);
            }
        }

        // 双発エンジンポッド（胴体上部両側）
        for (const z of [-0.78, 0.78]) {
            const eng = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.28, 1.7, 12), bodyMat);
            eng.rotation.z = Math.PI / 2;
            eng.position.set(-0.4, 1.05, z);
            this.group.add(eng);
            // インテーク
            const intake = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.30, 0.18, 12), new THREE.MeshBasicMaterial({ color: 0x080808 }));
            intake.rotation.z = Math.PI / 2;
            intake.position.set(0.48, 1.05, z);
            this.group.add(intake);
            // 排気管（オレンジ発光）
            const exh = new THREE.Mesh(
                new THREE.CylinderGeometry(0.18, 0.14, 0.22, 10),
                new THREE.MeshBasicMaterial({ color: 0xFFA840, transparent: true, opacity: 0.7,
                    blending: THREE.AdditiveBlending, depthWrite: false })
            );
            exh.rotation.z = Math.PI / 2;
            exh.position.set(-1.35, 0.92, z);
            this.group.add(exh);
        }

        // タンデムローター（前後 2 基）
        // 前方ローター（マスト前傾）
        const frontMast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.7, 8), metalMat);
        frontMast.position.set(1.85, 1.4, 0);
        this.group.add(frontMast);
        this.mainRotor = new THREE.Group();
        this.mainRotor.position.set(1.85, 1.78, 0);
        this.group.add(this.mainRotor);
        for (let i = 0; i < 3; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.05, 0.28), rotorMat);
            blade.rotation.y = (Math.PI * 2 / 3) * i;
            this.mainRotor.add(blade);
        }
        // 前ローターブラーディスク
        const frontBlur = new THREE.Mesh(
            new THREE.CircleGeometry(2.4, 24),
            new THREE.MeshBasicMaterial({ color: 0xBFBFBF, transparent: true, opacity: 0.2,
                depthWrite: false, side: THREE.DoubleSide })
        );
        frontBlur.rotation.x = -Math.PI / 2;
        frontBlur.position.set(1.85, 1.82, 0);
        this.group.add(frontBlur);

        // 後方ローター（マスト後ろ高め）
        const rearMast = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 1.0, 8), metalMat);
        rearMast.position.set(-1.85, 1.65, 0);
        this.group.add(rearMast);
        const rearRotor = new THREE.Group();
        rearRotor.position.set(-1.85, 2.15, 0);
        this.group.add(rearRotor);
        for (let i = 0; i < 3; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.05, 0.28), rotorMat);
            blade.rotation.y = (Math.PI * 2 / 3) * i;
            rearRotor.add(blade);
        }
        const rearBlur = new THREE.Mesh(
            new THREE.CircleGeometry(2.4, 24),
            new THREE.MeshBasicMaterial({ color: 0xBFBFBF, transparent: true, opacity: 0.2,
                depthWrite: false, side: THREE.DoubleSide })
        );
        rearBlur.rotation.x = -Math.PI / 2;
        rearBlur.position.set(-1.85, 2.19, 0);
        this.group.add(rearBlur);
        // 反転方向で回す
        this.extraRotors.push(rearRotor);

        // 翼端のロケットポッド（左右）
        const podArm = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.5, metalness: 0.4 });
        for (const z of [-1.25, 1.25]) {
            const arm = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.5), podArm);
            arm.position.set(-0.2, -0.55, z);
            this.group.add(arm);
            // ポッド本体
            const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.85, 12), new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.55, metalness: 0.35 }));
            pod.rotation.z = Math.PI / 2;
            pod.position.set(-0.2, -0.82, z);
            this.group.add(pod);
            // ロケット穴
            const podFace = new THREE.Mesh(new THREE.CircleGeometry(0.2, 14), new THREE.MeshBasicMaterial({ color: 0x080808 }));
            podFace.position.set(0.24, -0.82, z);
            podFace.rotation.y = Math.PI / 2;
            this.group.add(podFace);
            for (let r = 0; r < 7; r++) {
                const ang = (r / 7) * Math.PI * 2;
                const hole = new THREE.Mesh(new THREE.CircleGeometry(0.04, 6), new THREE.MeshBasicMaterial({ color: 0x331810 }));
                hole.position.set(0.245, -0.82 + Math.cos(ang) * 0.12, z + Math.sin(ang) * 0.12);
                hole.rotation.y = Math.PI / 2;
                this.group.add(hole);
            }
            // 翼端ミサイル（外側 2 発）
            for (const dz of [-0.18, 0.18]) {
                const m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.78, 8), new THREE.MeshStandardMaterial({ color: C.missile, roughness: 0.5 }));
                m.rotation.z = Math.PI / 2;
                m.position.set(-0.15, -0.55, z + dz);
                this.group.add(m);
                const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.18, 8), new THREE.MeshStandardMaterial({ color: C.accent }));
                tip.rotation.z = -Math.PI / 2;
                tip.position.set(0.32, -0.55, z + dz);
                this.group.add(tip);
            }
        }

        // 機首チンタレット（重機関砲）
        const chinPivot = new THREE.Mesh(
            new THREE.SphereGeometry(0.32, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
            new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.5, metalness: 0.45 })
        );
        chinPivot.rotation.x = Math.PI;
        chinPivot.position.set(3.6, -0.55, 0);
        this.group.add(chinPivot);
        // 三連砲身
        for (const z of [-0.1, 0, 0.1]) {
            const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 1.1, 8), metalMat);
            gun.rotation.z = Math.PI / 2;
            gun.position.set(4.18, -0.6, z);
            this.group.add(gun);
        }

        // 機体側面の赤い反乱軍ストライプ + マーキング
        const stripeMat = new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.55 });
        for (const z of [-0.86, 0.86]) {
            const stripe = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.18, 0.04), stripeMat);
            stripe.position.set(-0.05, 0.45, z);
            this.group.add(stripe);
        }
        // 側面の反乱軍三角マーク
        for (const z of [-0.88, 0.88]) {
            const triShape = new THREE.Shape();
            triShape.moveTo(-0.32, 0.18);
            triShape.lineTo(0.32, 0.18);
            triShape.lineTo(0, -0.32);
            triShape.closePath();
            const triGeo = new THREE.ShapeGeometry(triShape);
            const triMat = new THREE.MeshStandardMaterial({ color: C.accent, side: THREE.DoubleSide, roughness: 0.5, emissive: 0x180806, emissiveIntensity: 0.15 });
            const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 16), new THREE.MeshBasicMaterial({ color: 0xE8DEB4, side: THREE.DoubleSide }));
            disc.position.set(-1.6, 0, z);
            disc.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(disc);
            const tri = new THREE.Mesh(triGeo, triMat);
            tri.position.set(-1.6, 0, z + (z > 0 ? 0.005 : -0.005));
            tri.rotation.y = z > 0 ? 0 : Math.PI;
            this.group.add(tri);
        }

        // 着陸脚（短い支柱）
        const skidMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.5 });
        for (const z of [-0.86, 0.86]) {
            const strut = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), skidMat);
            strut.position.set(0, -1.25, z);
            this.group.add(strut);
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 10), new THREE.MeshStandardMaterial({ color: 0x1A1A18 }));
            wheel.rotation.x = Math.PI / 2;
            wheel.position.set(0, -1.5, z);
            this.group.add(wheel);
        }

        // ナビ点灯（夜戦識別）
        const navR = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicMaterial({ color: 0xFF2030 }));
        navR.position.set(0.5, -0.05, -1.65);
        this.group.add(navR);
        const navG = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), new THREE.MeshBasicMaterial({ color: 0x20FF40 }));
        navG.position.set(0.5, -0.05, 1.65);
        this.group.add(navG);
    }

    // ============================================
    // コンバットドローン (Combat Drone)
    //  Predator風 UCAV: 細長い胴体 + プッシャープロペラ + 逆V尾翼 + 翼下ミサイル。
    //  攻撃機より小型・低 HP だが、高速で旋回しながらレーザー風弾を散弾する。
    // ============================================
    _buildCombatDrone() {
        const C = {
            body:    0xD4CDA8,  // 砂漠迷彩のオフホワイト
            bodyDk:  0x9A9070,
            wing:    0xC0B894,
            sensor:  0x1A1A1E,
            sensorEye: 0x55D6FF,
            accent:  0xC44022,
            metal:   0x2A2A28,
            prop:    0x1F1F1B,
        };

        const bodyMat = new THREE.MeshStandardMaterial({ color: C.body, roughness: 0.55, metalness: 0.18 });
        const wingMat = new THREE.MeshStandardMaterial({ color: C.wing, roughness: 0.6, metalness: 0.16 });
        const metalMat = new THREE.MeshStandardMaterial({ color: C.metal, roughness: 0.4, metalness: 0.55 });

        // 細長い円筒胴体（local +X = 機首）
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 2.6, 10), bodyMat);
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        this.group.add(body);

        // 隆起した機首センサー部
        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), bodyMat);
        nose.scale.set(1.2, 0.95, 0.95);
        nose.position.set(1.35, 0.02, 0);
        this.group.add(nose);

        // 機首下のセンサーボール（カメラ）
        const sensorBall = new THREE.Mesh(
            new THREE.SphereGeometry(0.18, 12, 8),
            new THREE.MeshStandardMaterial({ color: C.sensor, roughness: 0.3, metalness: 0.6 })
        );
        sensorBall.position.set(1.05, -0.22, 0);
        this.group.add(sensorBall);
        // センサー目玉（青く発光）
        const eye = new THREE.Mesh(
            new THREE.SphereGeometry(0.085, 10, 8),
            new THREE.MeshBasicMaterial({ color: C.sensorEye })
        );
        eye.position.set(1.18, -0.22, 0);
        this.group.add(eye);

        // 主翼（細長く高アスペクト比）
        const wing = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.06, 4.6), wingMat);
        wing.position.set(0.1, 0.05, 0);
        if (!this._lowShadow) wing.castShadow = true;
        this.group.add(wing);
        // 翼の前縁ライン（薄い色）
        const wingEdge = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 4.55), new THREE.MeshStandardMaterial({ color: C.bodyDk, roughness: 0.55 }));
        wingEdge.position.set(0.5, 0.05, 0);
        this.group.add(wingEdge);

        // 翼下ミサイル（左右 2 発ずつ、計 4 発）
        for (const z of [-1.1, -1.95, 1.1, 1.95]) {
            const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.08), metalMat);
            pylon.position.set(0.05, -0.06, z);
            this.group.add(pylon);
            const missile = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), new THREE.MeshStandardMaterial({ color: 0xCFCBA8, roughness: 0.42, metalness: 0.4 }));
            missile.rotation.z = Math.PI / 2;
            missile.position.set(0.0, -0.18, z);
            this.group.add(missile);
            // 弾頭
            const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 8), new THREE.MeshStandardMaterial({ color: C.accent }));
            tip.rotation.z = -Math.PI / 2;
            tip.position.set(0.42, -0.18, z);
            this.group.add(tip);
            // 尾翼
            for (const ya of [0, Math.PI / 2]) {
                const fin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.02), new THREE.MeshStandardMaterial({ color: C.metal }));
                fin.position.set(-0.3, -0.18, z);
                fin.rotation.x = ya;
                this.group.add(fin);
            }
        }

        // 逆V尾翼（V字、Predator風）
        for (const sign of [-1, 1]) {
            const vtail = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), wingMat);
            vtail.position.set(-1.1, 0.18, sign * 0.32);
            vtail.rotation.z = 0.0;
            vtail.rotation.x = sign * 0.7;
            this.group.add(vtail);
        }

        // プッシャープロペラ（後方）
        this.mainRotor = new THREE.Group();
        this.mainRotor.position.set(-1.42, 0, 0);
        this.group.add(this.mainRotor);
        for (let i = 0; i < 2; i++) {
            const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.95, 0.08), new THREE.MeshStandardMaterial({ color: C.prop, roughness: 0.4 }));
            blade.rotation.z = i * Math.PI / 2;
            this.mainRotor.add(blade);
        }
        // プロペラブラー
        const propBlur = new THREE.Mesh(
            new THREE.CircleGeometry(0.5, 18),
            new THREE.MeshBasicMaterial({ color: 0xC0C0C0, transparent: true, opacity: 0.18,
                depthWrite: false, side: THREE.DoubleSide })
        );
        propBlur.rotation.y = Math.PI / 2;
        propBlur.position.set(-1.45, 0, 0);
        this.group.add(propBlur);
        // スピナー
        const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 8), metalMat);
        spinner.rotation.z = Math.PI / 2;
        spinner.position.set(-1.5, 0, 0);
        this.group.add(spinner);

        // 上面の赤いストライプ + 反乱軍マーク
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.03, 0.3), new THREE.MeshStandardMaterial({ color: C.accent, roughness: 0.5 }));
        stripe.position.set(0.1, 0.22, 0);
        this.group.add(stripe);
        // 三角マーク
        const triShape = new THREE.Shape();
        triShape.moveTo(-0.16, 0.10);
        triShape.lineTo(0.16, 0.10);
        triShape.lineTo(0, -0.18);
        triShape.closePath();
        const triGeo = new THREE.ShapeGeometry(triShape);
        const tri = new THREE.Mesh(triGeo, new THREE.MeshStandardMaterial({ color: C.accent, side: THREE.DoubleSide, roughness: 0.5, emissive: 0x180806, emissiveIntensity: 0.18 }));
        tri.rotation.x = -Math.PI / 2;
        tri.position.set(-0.2, 0.25, 0);
        this.group.add(tri);

        // 後端の赤ナビ点
        const navTail = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 4), new THREE.MeshBasicMaterial({ color: 0xFF2030 }));
        navTail.position.set(-1.6, 0.05, 0);
        this.group.add(navTail);
    }

    /**
     * 大型輸送ヘリの AI: 中空ホバ→ロケット斉射→横移動→ドアガナー乱射
     */
    _aiHeavyHeli(dt, playerPos, elapsed) {
        const phases = [
            { duration: 3.5, action: 'approach' },
            { duration: 2.8, action: 'volley'   },
            { duration: 3.0, action: 'broadside' },
            { duration: 1.8, action: 'reposition' },
        ];
        const phase = phases[this.aiPhase % phases.length];
        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            this.entryDir = Math.random() > 0.5 ? 1 : -1;
        }

        const dir = new THREE.Vector3().subVectors(playerPos, this.group.position);
        dir.y = 0;
        if (dir.lengthSq() > 0.1) {
            this.group.rotation.y = Math.atan2(-dir.z, dir.x);
        }

        if (phase.action === 'approach') {
            const target = playerPos.clone();
            target.x += this.entryDir * 5.0;
            target.z += 14.0;
            target.y = this.flightHeight;
            this.group.position.lerp(target, Math.min(1, dt * 1.4));
            this.group.rotation.x = -0.06;
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'volley') {
            this.group.position.y += (this.flightHeight - this.group.position.y) * dt * 2.2;
            this.group.rotation.x *= 0.9;
            this._fireHeavyHeliRockets(playerPos, elapsed);
        } else if (phase.action === 'broadside') {
            // 横方向へゆっくり進みながらドアガナー乱射
            const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
            this.group.position.add(side.multiplyScalar(this.entryDir * this.speed * 1.0 * dt));
            this.group.position.y += (this.flightHeight - this.group.position.y) * dt * 1.8;
            this.group.rotation.z = this.entryDir * 0.12;
            this._fireDoorGunner(playerPos, elapsed);
        } else {
            const target = playerPos.clone();
            target.x -= this.entryDir * 10.0;
            target.z += 16.0;
            target.y = this.flightHeight + 0.8;
            this.group.position.lerp(target, Math.min(1, dt * 1.6));
            this.group.rotation.x = 0.08;
        }

        // ローター: 後方ローターは前と反転
        if (this.extraRotors[0]) {
            this.extraRotors[0].rotation.y = -this.rotorAngle * 1.05;
        }
    }

    _fireHeavyHeliRockets(playerPos, elapsed) {
        if (elapsed - (this.lastRocketTime || 0) < 1.6) return;
        this.lastRocketTime = elapsed;
        this._attackTimers = this._attackTimers || [];
        // 翼端ポッドから 6 発を時間差で
        for (let i = 0; i < 6; i++) {
            const side = i < 3 ? -1.25 : 1.25;
            const offIdx = i % 3;
            const tid = setTimeout(() => {
                if (!this.alive) return;
                const localOff = new THREE.Vector3(0.3, -0.82, side + (offIdx - 1) * 0.15);
                const pos = this.group.localToWorld(localOff);
                const dir = new THREE.Vector3().subVectors(playerPos, pos);
                dir.y += 1.5;
                dir.normalize();
                const rocket = new Projectile(this.scene, {
                    position: pos,
                    direction: dir,
                    speed: 17,
                    damage: this.damage,
                    owner: 'enemy',
                    type: 'rocket',
                    maxDistance: 70,
                });
                this.projectiles.push(rocket);
            }, i * 110);
            this._attackTimers.push(tid);
        }
    }

    _fireDoorGunner(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < 0.12) return;
        this.lastFireTime = elapsed;
        const localOff = new THREE.Vector3(0.55, -0.05, (this.entryDir > 0 ? 1.32 : -1.32));
        const pos = this.group.localToWorld(localOff);
        const dir = new THREE.Vector3().subVectors(playerPos, pos);
        dir.y = 0;
        dir.x += (Math.random() - 0.5) * 0.18;
        dir.z += (Math.random() - 0.5) * 0.18;
        dir.normalize();
        const bullet = new Projectile(this.scene, {
            position: pos,
            direction: dir,
            speed: 32,
            damage: Math.max(6, Math.floor(this.damage * 0.4)),
            owner: 'enemy',
            type: 'bullet',
            maxDistance: 80,
        });
        this.projectiles.push(bullet);
    }

    /**
     * コンバットドローンの AI: 高速 figure-8 → 直線突撃 → 旋回離脱
     */
    _aiCombatDrone(dt, playerPos, elapsed) {
        const phases = [
            { duration: 2.4, action: 'figure8' },
            { duration: 1.3, action: 'strafe'  },
            { duration: 1.0, action: 'breakaway' },
        ];
        const phase = phases[this.aiPhase % phases.length];
        if (this.aiTimer > phase.duration) {
            this.aiTimer = 0;
            this.aiPhase++;
            if (phase.action === 'breakaway') this.entryDir *= -1;
        }

        const prev = this.group.position.clone();

        if (phase.action === 'figure8') {
            // 8 の字旋回
            this.orbitAngle += dt * 1.8;
            const r = 14.0;
            const target = new THREE.Vector3(
                playerPos.x + Math.sin(this.orbitAngle) * r,
                this.flightHeight + Math.sin(this.orbitAngle * 2) * 0.6,
                playerPos.z + Math.sin(this.orbitAngle * 2) * r * 0.55,
            );
            this.group.position.lerp(target, Math.min(1, dt * 2.6));
            this._fire(playerPos, elapsed);
        } else if (phase.action === 'strafe') {
            // プレイヤー方向に直線突撃しつつ連射
            const target = playerPos.clone();
            target.y = this.flightHeight - 0.4;
            const move = new THREE.Vector3().subVectors(target, this.group.position);
            if (move.lengthSq() > 0.01) this.group.position.add(move.normalize().multiplyScalar(this.speed * 1.3 * dt));
            this._fireDroneBurst(playerPos, elapsed);
        } else {
            // 離脱: プレイヤー反対方向＆上昇
            const target = playerPos.clone();
            target.x += this.entryDir * 18.0;
            target.z -= 4.0;
            target.y = this.flightHeight + 2.0;
            this.group.position.lerp(target, Math.min(1, dt * 1.8));
            this.group.rotation.x = 0.22;
        }

        const vel = this.group.position.clone().sub(prev);
        if (vel.lengthSq() > 0.0001) {
            const angle = Math.atan2(-vel.z, vel.x);
            this.group.rotation.y = angle;
            this.group.rotation.z = THREE.MathUtils.clamp(-vel.x * 0.2, -0.32, 0.32);
            if (phase.action !== 'breakaway') this.group.rotation.x = -0.12;
        }
    }

    _fireDroneBurst(playerPos, elapsed) {
        if (elapsed - this.lastFireTime < 0.18) return;
        this.lastFireTime = elapsed;
        // 翼下ハードポイントから散弾的に
        const localOff = new THREE.Vector3(0.4, -0.18, 0);
        const pos = this.group.localToWorld(localOff);
        const baseDir = new THREE.Vector3().subVectors(playerPos, pos);
        baseDir.y = 0;
        baseDir.normalize();
        for (const offset of [-0.05, 0.05]) {
            const dir = baseDir.clone();
            dir.x += offset + (Math.random() - 0.5) * 0.06;
            dir.z += (Math.random() - 0.5) * 0.06;
            dir.normalize();
            const bullet = new Projectile(this.scene, {
                position: pos.clone(),
                direction: dir,
                speed: 36,
                damage: this.damage,
                owner: 'enemy',
                type: 'bullet',
                maxDistance: 75,
            });
            this.projectiles.push(bullet);
        }
    }
}
