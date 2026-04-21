import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { Projectile } from './Projectile.js';

/**
 * 航空系の敵
 * subType: 'scout_heli' | 'attack_heli' | 'bomber' | 'fighter'
 */
export class Aircraft extends Enemy {
    constructor(scene, {
        position,
        subType = 'scout_heli',
    }) {
        // 航空機スコア（原作 Metal Slug 相当）
        //   scout_heli: 800 / attack_heli (R-Shobu系): 2000 / bomber: 1500 / fighter: 1200
        const SPECS = {
            scout_heli:  { hp: 25,  speed: 5,  scoreValue: 800,  fireRate: 1.0,  damage: 8  },
            attack_heli: { hp: 75,  speed: 4,  scoreValue: 2000, fireRate: 2.5,  damage: 15 },
            bomber:      { hp: 60,  speed: 7,  scoreValue: 1500, fireRate: 2.0,  damage: 20 },
            fighter:     { hp: 25,  speed: 12, scoreValue: 1200, fireRate: 0.15, damage: 5  },
        };
        const spec = SPECS[subType] || SPECS.scout_heli;

        super(scene, { position, ...spec, type: 'aircraft' });
        this.subType = subType;

        // 飛行高度
        this.flightHeight = position.y || 12;
        this.group.position.y = this.flightHeight;

        // AI状態
        this.aiPhase = 0;
        this.aiTimer = 0;
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.orbitRadius = 15 + Math.random() * 10;
        this.diveProgress = 0;
        this.burstCount = 0;
        this.entryDir = Math.random() > 0.5 ? 1 : -1; // 進入方向

        // ローター回転用
        this.rotorAngle = 0;

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
        }
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

        // ローターハブ
        const hubGeo = new THREE.CylinderGeometry(0.1, 0.1, 0.15, 8);
        const hubMat = new THREE.MeshStandardMaterial({ color: C.metal, metalness: 0.5 });
        const hub = new THREE.Mesh(hubGeo, hubMat);
        hub.position.y = 0.75;
        this.group.add(hub);

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

        // 武装パイロン + ミサイルポッド
        for (let z of [-0.9, 0.9]) {
            // パイロン
            const pylonGeo = new THREE.BoxGeometry(0.6, 0.06, 0.06);
            const pylonMat = new THREE.MeshStandardMaterial({ color: C.metal });
            const pylon = new THREE.Mesh(pylonGeo, pylonMat);
            pylon.position.set(0, -0.5, z);
            this.group.add(pylon);

            // ミサイル x 2
            for (let x of [-0.15, 0.15]) {
                const missileGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6);
                const missileMat = new THREE.MeshStandardMaterial({
                    color: C.missile, roughness: 0.5
                });
                const missile = new THREE.Mesh(missileGeo, missileMat);
                missile.rotation.z = Math.PI / 2;
                missile.position.set(x, -0.6, z);
                this.group.add(missile);
            }
        }

        // 機首の機銃
        const gunGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6);
        const gunMat = new THREE.MeshStandardMaterial({
            color: C.metal, roughness: 0.3, metalness: 0.7
        });
        const gun = new THREE.Mesh(gunGeo, gunMat);
        gun.rotation.z = Math.PI / 2;
        gun.position.set(1.5, -0.4, 0);
        this.group.add(gun);
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
        wing.castShadow = true;
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
            const engGeo = new THREE.CylinderGeometry(0.2, 0.25, 0.8, 8);
            const engMat = new THREE.MeshStandardMaterial({
                color: C.engine, roughness: 0.4, metalness: 0.4
            });
            const eng = new THREE.Mesh(engGeo, engMat);
            eng.rotation.z = Math.PI / 2;
            eng.position.set(-0.1, -0.15, z);
            this.group.add(eng);

            // プロペラ（回転用）
            const propGroup = new THREE.Group();
            const propGeo = new THREE.BoxGeometry(0.05, 1.0, 0.12);
            const propMat = new THREE.MeshStandardMaterial({ color: 0x2A2A2A });
            const p1 = new THREE.Mesh(propGeo, propMat);
            propGroup.add(p1);
            const p2 = new THREE.Mesh(propGeo, propMat);
            p2.rotation.z = Math.PI / 2;
            propGroup.add(p2);
            propGroup.position.set(0.3, -0.15, z);
            this.group.add(propGroup);

            if (!this.mainRotor) this.mainRotor = propGroup;
            else this.tailRotor = propGroup;
        }
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
            wing.castShadow = true;
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

        // ダミーのローター（プロペラなし、互換性のため）
        this.mainRotor = null;
        this.tailRotor = null;
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
                this.group.position.y += (this.flightHeight + 5 - this.group.position.y) * dt * 3;

                this.group.rotation.z = -Math.sin(this.orbitAngle * 2) * 0.3;
                break;

            case 'dive': {
                const target = playerPos.clone();
                target.y = 3;
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
}
