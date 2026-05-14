import * as THREE from 'three';

const POW_STATES = {
    TIED: 'tied',
    RELEASED: 'released',
    LEAVING: 'leaving',
    DEAD: 'dead',
};

export class POW {
    constructor(scene, position) {
        this.scene = scene;
        this.state = POW_STATES.TIED;
        this.alive = true;
        this.hp = 5;
        this.age = 0;
        this.stateTime = 0;
        this.reward = this._rollReward();
        this.runSpeed = 6.0;
        this.walkPhase = 0;
        this.pendingReward = null;

        this.group = new THREE.Group();
        this._buildModel();
        this.group.position.copy(position);
        this.scene.add(this.group);
    }

    _rollReward() {
        const roll = Math.random();
        if (roll < 0.40) return 'weapon_H';
        if (roll < 0.65) return 'weapon_R';
        if (roll < 0.85) return 'grenade';
        return 'score_big';
    }

    _buildModel() {
        const uniformMat     = new THREE.MeshStandardMaterial({ color: 0x6B6A3A, roughness: 0.85 });
        const uniformDarkMat = new THREE.MeshStandardMaterial({ color: 0x46451E, roughness: 0.85 });
        const pantsMat       = new THREE.MeshStandardMaterial({ color: 0x55542A, roughness: 0.85 });
        const skinMat        = new THREE.MeshStandardMaterial({ color: 0xE8C28F, roughness: 0.7 });
        const helmetMat      = new THREE.MeshStandardMaterial({ color: 0x3A4628, roughness: 0.55, metalness: 0.25 });
        const beltMat        = new THREE.MeshStandardMaterial({ color: 0x2D1F12, roughness: 0.8 });
        const buckleMat      = new THREE.MeshStandardMaterial({ color: 0xC8AE5C, metalness: 0.7, roughness: 0.35 });
        const bootMat        = new THREE.MeshStandardMaterial({ color: 0x1B130D, roughness: 0.75 });
        const poleMat        = new THREE.MeshStandardMaterial({ color: 0x6A4824, roughness: 0.85 });
        const flagMat        = new THREE.MeshStandardMaterial({ color: 0xF8F4EA, roughness: 0.95, side: THREE.DoubleSide });
        const flagShadowMat  = new THREE.MeshStandardMaterial({ color: 0xD8D2C0, roughness: 0.95, side: THREE.DoubleSide });
        const faceMat        = new THREE.MeshStandardMaterial({ color: 0x1A1410, roughness: 0.9 });
        const mouthMat       = new THREE.MeshStandardMaterial({ color: 0x4A2018, roughness: 0.9 });
        const sweatMat       = new THREE.MeshStandardMaterial({ color: 0x9FD9F2, transparent: true, opacity: 0.85, emissive: 0x4A7E96, emissiveIntensity: 0.5 });

        // ----- 胴体 -----
        const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.70, 0.32), uniformMat);
        torso.position.y = 1.05;
        this.group.add(torso);

        // 襟
        const collar = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.10, 0.34), uniformDarkMat);
        collar.position.y = 1.40;
        this.group.add(collar);

        // 前立て (ボタン列の縦ライン)
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.58, 0.04), uniformDarkMat);
        stripe.position.set(0, 1.05, 0.17);
        this.group.add(stripe);

        // ボタン
        for (const y of [1.28, 1.13, 0.98, 0.83]) {
            const btn = new THREE.Mesh(new THREE.SphereGeometry(0.032, 6, 6), buckleMat);
            btn.position.set(0, y, 0.195);
            this.group.add(btn);
        }

        // 肩章
        const shoulderL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.10, 0.30), uniformDarkMat);
        shoulderL.position.set(-0.27, 1.35, 0.0);
        this.group.add(shoulderL);
        const shoulderR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.10, 0.30), uniformDarkMat);
        shoulderR.position.set(0.27, 1.35, 0.0);
        this.group.add(shoulderR);

        // ベルトとバックル
        const belt = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.34), beltMat);
        belt.position.y = 0.74;
        this.group.add(belt);
        const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.085, 0.04), buckleMat);
        buckle.position.set(0, 0.74, 0.195);
        this.group.add(buckle);

        // 弾入れ (空)
        const pouchL = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.10, 0.10), beltMat);
        pouchL.position.set(-0.17, 0.78, 0.21);
        this.group.add(pouchL);
        const pouchR = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.10, 0.10), beltMat);
        pouchR.position.set(0.17, 0.78, 0.21);
        this.group.add(pouchR);

        // ----- 首 -----
        const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.10, 0.10, 8), skinMat);
        neck.position.y = 1.48;
        this.group.add(neck);

        // ----- 頭 -----
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 12), skinMat);
        head.position.y = 1.68;
        head.scale.set(1.0, 1.1, 1.0);
        this.group.add(head);

        // 耳
        const earL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), skinMat);
        earL.position.set(-0.23, 1.68, 0.02);
        earL.scale.set(0.6, 1.0, 0.7);
        this.group.add(earL);
        const earR = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), skinMat);
        earR.position.set(0.23, 1.68, 0.02);
        earR.scale.set(0.6, 1.0, 0.7);
        this.group.add(earR);

        // ヘルメット (ドーム)
        const helmet = new THREE.Mesh(
            new THREE.SphereGeometry(0.28, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.60),
            helmetMat
        );
        helmet.position.y = 1.74;
        this.group.add(helmet);
        // ヘルメット縁
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.275, 0.028, 6, 18), helmetMat);
        rim.position.y = 1.66;
        rim.rotation.x = Math.PI / 2;
        this.group.add(rim);
        // ヘルメット鉢巻 (薄バンド)
        const helmetBand = new THREE.Mesh(
            new THREE.TorusGeometry(0.282, 0.014, 4, 20),
            new THREE.MeshStandardMaterial({ color: 0x2A331E, roughness: 0.9 })
        );
        helmetBand.position.y = 1.69;
        helmetBand.rotation.x = Math.PI / 2;
        this.group.add(helmetBand);
        // 額の徽章 (くすんだ星)
        const badge = new THREE.Mesh(
            new THREE.CircleGeometry(0.045, 5),
            new THREE.MeshStandardMaterial({ color: 0xC8AE5C, metalness: 0.7, roughness: 0.35, side: THREE.DoubleSide })
        );
        badge.position.set(0, 1.82, 0.25);
        badge.rotation.x = -0.25;
        this.group.add(badge);

        // 顔: 眉 (困り眉)、閉じた目、開いた口、汗
        const browL = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.014, 0.02), faceMat);
        browL.position.set(-0.09, 1.74, 0.235);
        browL.rotation.z = -0.25;
        this.group.add(browL);
        const browR = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.014, 0.02), faceMat);
        browR.position.set(0.09, 1.74, 0.235);
        browR.rotation.z = 0.25;
        this.group.add(browR);

        const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), faceMat);
        eyeL.position.set(-0.09, 1.69, 0.235);
        this.group.add(eyeL);
        const eyeR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), faceMat);
        eyeR.position.set(0.09, 1.69, 0.235);
        this.group.add(eyeR);

        const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), mouthMat);
        mouth.position.set(0, 1.59, 0.24);
        mouth.scale.set(1.1, 0.65, 0.5);
        this.group.add(mouth);

        // 鼻
        const nose = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), skinMat);
        nose.position.set(0, 1.64, 0.245);
        nose.scale.set(1.0, 1.2, 1.0);
        this.group.add(nose);

        // 汗
        const sweat = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), sweatMat);
        sweat.position.set(0.22, 1.65, 0.14);
        sweat.scale.set(1.0, 1.6, 1.0);
        this.group.add(sweat);

        // ----- 両腕 (Group で肩を軸に上げる) -----
        this.armL = new THREE.Group();
        this.armL.position.set(-0.30, 1.36, 0.02);
        const armLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.13), uniformMat);
        armLMesh.position.y = -0.18;
        this.armL.add(armLMesh);
        const cuffL = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.06, 0.135), uniformDarkMat);
        cuffL.position.y = -0.36;
        this.armL.add(cuffL);
        const handL = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMat);
        handL.position.y = -0.43;
        this.armL.add(handL);
        this.armL.rotation.z = -2.65;
        this.group.add(this.armL);

        this.armR = new THREE.Group();
        this.armR.position.set(0.30, 1.36, 0.02);
        const armRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.42, 0.13), uniformMat);
        armRMesh.position.y = -0.18;
        this.armR.add(armRMesh);
        const cuffR = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.06, 0.135), uniformDarkMat);
        cuffR.position.y = -0.36;
        this.armR.add(cuffR);
        const handR = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMat);
        handR.position.y = -0.43;
        this.armR.add(handR);
        this.armR.rotation.z = 2.65;
        this.group.add(this.armR);

        // ----- 白旗 (右手位置に立てる) -----
        this.flagGroup = new THREE.Group();
        this.flagGroup.position.set(0.50, 1.74, 0.02);
        this.group.add(this.flagGroup);

        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 1.20, 10), poleMat);
        pole.position.y = 0.60;
        this.flagGroup.add(pole);
        // ポール先端の金具
        const poleCap = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), buckleMat);
        poleCap.position.y = 1.22;
        this.flagGroup.add(poleCap);
        // 握り (布テープ)
        const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.10, 8), beltMat);
        grip.position.y = 0.06;
        this.flagGroup.add(grip);

        // 旗布 (ポールの片側に長方形の白布)
        this.flagCloth = new THREE.Group();
        this.flagCloth.position.set(0, 1.02, 0);
        this.flagGroup.add(this.flagCloth);

        const clothW = 0.60;
        const clothH = 0.40;
        const clothGeo = new THREE.PlaneGeometry(clothW, clothH);
        const clothFront = new THREE.Mesh(clothGeo, flagMat);
        clothFront.position.set(clothW / 2, 0, 0.003);
        this.flagCloth.add(clothFront);
        const clothBack = new THREE.Mesh(clothGeo, flagShadowMat);
        clothBack.position.set(clothW / 2, 0, -0.003);
        clothBack.rotation.y = Math.PI;
        this.flagCloth.add(clothBack);

        // ----- 両脚 (Group で股関節を軸に振る) -----
        this.legL = new THREE.Group();
        this.legL.position.set(-0.13, 0.70, 0);
        const legLMesh = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.55, 0.20), pantsMat);
        legLMesh.position.y = -0.28;
        this.legL.add(legLMesh);
        const kneeL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.045, 0.21), beltMat);
        kneeL.position.y = -0.26;
        this.legL.add(kneeL);
        const bootL = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.18, 0.30), bootMat);
        bootL.position.set(0, -0.66, 0.05);
        this.legL.add(bootL);
        this.group.add(this.legL);

        this.legR = new THREE.Group();
        this.legR.position.set(0.13, 0.70, 0);
        const legRMesh = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.55, 0.20), pantsMat);
        legRMesh.position.y = -0.28;
        this.legR.add(legRMesh);
        const kneeR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.045, 0.21), beltMat);
        kneeR.position.y = -0.26;
        this.legR.add(kneeR);
        const bootR = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.18, 0.30), bootMat);
        bootR.position.set(0, -0.66, 0.05);
        this.legR.add(bootR);
        this.group.add(this.legR);

        // ロープは無し (降参して旗を掲げている)
        this.ropes = null;

        // 助けを求める "!"
        this.exclaim = this._makeExclaim();
        this.exclaim.position.y = 2.55;
        this.group.add(this.exclaim);
    }

    _makeExclaim() {
        const g = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color: 0xFFEE33 });
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.28, 0.08), mat);
        stem.position.y = 0.15;
        const dot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), mat);
        dot.position.y = -0.05;
        g.add(stem);
        g.add(dot);
        return g;
    }

    release() {
        if (this.state !== POW_STATES.TIED) return;
        this.state = POW_STATES.RELEASED;
        this.stateTime = 0;
        if (this.flagGroup) {
            this.group.remove(this.flagGroup);
            this.flagGroup.traverse(c => {
                if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
            });
            this.flagGroup = null;
            this.flagCloth = null;
        }
        this.armL.rotation.z = -2.6;
        this.armR.rotation.z = 2.6;
        if (this.exclaim) {
            this.group.remove(this.exclaim);
            this.exclaim = null;
        }
    }

    update(dt, playerPos) {
        if (!this.alive) return;
        this.age += dt;
        this.stateTime += dt;

        if (this.state === POW_STATES.TIED) {
            if (this.exclaim) this.exclaim.visible = Math.floor(this.age * 4) % 2 === 0;
            if (this.flagCloth) {
                this.flagCloth.rotation.y = Math.sin(this.age * 3.0) * 0.35;
            }
            if (this.flagGroup) {
                this.flagGroup.rotation.z = Math.sin(this.age * 2.0) * 0.08;
            }
            return;
        }

        if (this.state === POW_STATES.RELEASED) {
            const phase = Math.sin(this.stateTime * 12);
            this.armL.rotation.z = -2.6 + phase * 0.35;
            this.armR.rotation.z = 2.6 - phase * 0.35;
            if (this.stateTime > 1.2) {
                this.state = POW_STATES.LEAVING;
                this.stateTime = 0;
                this._dropReward();
                this.armL.rotation.z = -0.25;
                this.armR.rotation.z = 0.25;
            }
            return;
        }

        if (this.state === POW_STATES.LEAVING) {
            const dx = this.group.position.x - playerPos.x;
            const dz = this.group.position.z - playerPos.z;
            const len = Math.hypot(dx, dz) || 1;
            this.group.position.x += (dx / len) * this.runSpeed * dt;
            this.group.position.z += (dz / len) * this.runSpeed * dt;
            this.group.rotation.y = Math.atan2(dx, dz);
            this.walkPhase += dt * 15;
            this.legL.rotation.x = Math.sin(this.walkPhase) * 0.6;
            this.legR.rotation.x = -Math.sin(this.walkPhase) * 0.6;
            this.armL.rotation.x = -Math.sin(this.walkPhase) * 0.5;
            this.armR.rotation.x = Math.sin(this.walkPhase) * 0.5;
            if (this.stateTime > 4.0) {
                this.alive = false;
            }
        }
    }

    _dropReward() {
        this.pendingReward = this.reward;
    }

    takeDamage(amount) {
        if (!this.alive || this.state === POW_STATES.LEAVING) return;
        this.hp -= amount;
        if (this.hp <= 0) {
            this.alive = false;
            this.state = POW_STATES.DEAD;
        }
    }

    destroy() {
        this.alive = false;
        this.scene.remove(this.group);
        this.group.traverse(c => {
            if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
        });
    }
}
