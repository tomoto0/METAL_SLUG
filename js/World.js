import * as THREE from 'three';

/**
 * Metal Slug風 縦スクロール 3D 用ワールド
 * プレイヤーは +Z 方向（前方）へ自動前進する
 * - 多層パララックス背景（左右の壁として配置）
 * - 石造りの建物群、監視塔、鉄骨構造物
 * - 道路、地面テクスチャ
 * - 環境小道具（土嚢、木箱、ドラム缶、有刺鉄線、テント、看板）
 */
export class World {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.options = options;
        this.backgroundPhotoUrl = this.options.backgroundPhotoUrl || null;
        this.chunks = [];
        this.chunkSize = 30;
        this.lastChunkZ = -this.chunkSize;
        this.viewRange = 60;
        this.cleanupRange = 40;

        this.bgLayers = [];
        this.props = [];
        this.clouds = [];
        this.photoForegroundMeshes = [];

        this._buildSky();
        this._buildParallaxLayers();
        this._buildGround();

        // パララックス・雲を +Z 縦スクロール用に座標変換（+X/-X 両側の壁に再配置）
        this._transformLayersToForwardScroll();
        this._transformCloudsToForwardScroll();

        for (let z = -this.chunkSize; z <= this.chunkSize * 2; z += this.chunkSize) {
            this._generateChunk(z);
        }
    }

    /**
     * パララックス背景の座標変換（X 横スクロール → Z 縦スクロール）
     * 各オブジェクトの (x, y, z) を (lateral_side*depth, y, original_x) に再配置し、
     * 交互に左右へ割り振る。
     */
    _transformLayersToForwardScroll() {
        this.bgLayers.forEach(layer => {
            const depth = Math.abs(layer.zPos || 60);
            layer.objects.forEach((obj, i) => {
                const origX = obj.position.x;
                const origZ = obj.position.z;
                const zJitter = origZ - (layer.zPos || 0);
                const side = (i % 2 === 0) ? -1 : 1;
                obj.position.x = side * (depth + zJitter * 0.5);
                obj.position.z = origX;
                obj.rotation.y += side > 0 ? -Math.PI / 2 : Math.PI / 2;
            });
        });
    }

    _transformCloudsToForwardScroll() {
        this.clouds.forEach(c => {
            const origX = c.group.position.x;  // 元の X 拡散（-70 〜 +70）
            const origZ = c.group.position.z;  // 元の Z 深さ（-35 〜 -85）
            c.group.position.x = origZ;        // 雲は空なので左側（-X）に来る → 受け入れる
            c.group.position.z = origX;        // 前後方向へ散らす
            c.baseX = c.group.position.x;
        });
    }

    /* ========================================================
     *  SKY - Metal Slug風の温かな砂漠の空
     *  コンセプト画像 07_desert_background.jpg より
     * ======================================================== */
    _buildSky() {
        const skyGeo = new THREE.SphereGeometry(200, 32, 16);
        const skyMat = new THREE.ShaderMaterial({
            uniforms: {
                topColor:    { value: new THREE.Color(0x1E5CB3) },  // Metal Slug風 鮮やかな深い青
                midColor:    { value: new THREE.Color(0x5EA8E0) },  // クリアスカイブルー
                bottomColor: { value: new THREE.Color(0xFAE8B0) },  // 暖かい砂色（地平線下）
                horizonColor:{ value: new THREE.Color(0xFFCC55) },  // 鮮やかなゴールデンホライズン
                offset:      { value: 10 },
                exponent:    { value: 0.5 },
            },
            vertexShader: `
                varying vec3 vWorldPosition;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldPosition = worldPosition.xyz;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 topColor;
                uniform vec3 midColor;
                uniform vec3 bottomColor;
                uniform vec3 horizonColor;
                uniform float offset;
                uniform float exponent;
                varying vec3 vWorldPosition;
                void main() {
                    float h = normalize(vWorldPosition + offset).y;
                    vec3 color;
                    if (h > 0.3) {
                        color = mix(midColor, topColor, pow((h - 0.3) / 0.7, 0.8));
                    } else if (h > 0.05) {
                        color = mix(horizonColor, midColor, (h - 0.05) / 0.25);
                    } else {
                        color = mix(bottomColor, horizonColor, max(h / 0.05, 0.0));
                    }
                    gl_FragColor = vec4(color, 1.0);
                }
            `,
            side: THREE.BackSide,
        });
        const sky = new THREE.Mesh(skyGeo, skyMat);
        this.scene.add(sky);
        this.skyMesh = sky;

        // Web由来の背景写真レイヤー（ライセンス許諾済み素材を想定）
        const photoUrl = this.options.backgroundPhotoUrl || null;
        if (photoUrl) {
            const photoSphere = new THREE.Mesh(
                new THREE.SphereGeometry(198, 48, 24),
                new THREE.MeshBasicMaterial({
                    color: 0xFFFFFF,
                    transparent: true,
                    opacity: 0.42,
                    side: THREE.BackSide,
                    depthWrite: false,
                    fog: false,
                })
            );
            photoSphere.visible = false;
            this.scene.add(photoSphere);
            this.skyPhotoMesh = photoSphere;

            const loader = new THREE.TextureLoader();
            loader.crossOrigin = 'anonymous';
            loader.load(
                photoUrl,
                (tex) => {
                    tex.colorSpace = THREE.SRGBColorSpace;
                    tex.wrapS = THREE.RepeatWrapping;
                    tex.wrapT = THREE.ClampToEdgeWrapping;
                    tex.anisotropy = 4;
                    this.skyPhotoMesh.material.map = tex;
                    this.skyPhotoMesh.material.needsUpdate = true;
                    this.skyPhotoMesh.visible = true;
                    this.photoForegroundMeshes.forEach(({ mesh }) => {
                        mesh.material.map = tex;
                        mesh.material.needsUpdate = true;
                    });
                },
                undefined,
                () => {
                    this.skyPhotoMesh.visible = false;
                }
            );
        }

        // 写真背景モードでは雲を重ねず、同一画像で統一感を優先
        if (!this.backgroundPhotoUrl) {
            this._buildClouds();
        }
    }

    _buildClouds() {
        const cloudColors = [0xFFF8F0, 0xFFF0E0, 0xFFE8D0, 0xFFDDC0];
        for (let i = 0; i < 22; i++) {
            const cloudGroup = new THREE.Group();
            const numPuffs = 5 + Math.floor(Math.random() * 6);
            const baseSize = 2.5 + Math.random() * 4.0;
            const colorIdx = Math.floor(Math.random() * cloudColors.length);

            for (let j = 0; j < numPuffs; j++) {
                const puffGeo = new THREE.SphereGeometry(
                    baseSize * (0.5 + Math.random() * 0.6), 8, 6
                );
                const puffMat = new THREE.MeshStandardMaterial({
                    color: cloudColors[colorIdx],
                    transparent: true,
                    opacity: 0.65 + Math.random() * 0.25,
                    roughness: 0.95,
                    emissive: 0xFFE8C0,
                    emissiveIntensity: 0.05,
                });
                const puff = new THREE.Mesh(puffGeo, puffMat);
                puff.position.set(
                    (Math.random() - 0.5) * baseSize * 3,
                    (Math.random() - 0.5) * baseSize * 0.6,
                    (Math.random() - 0.5) * baseSize * 1.5
                );
                puff.scale.y = 0.35 + Math.random() * 0.25;
                cloudGroup.add(puff);
            }
            // 雲の底面を暗くする影パフ
            const shadowPuff = new THREE.Mesh(
                new THREE.SphereGeometry(baseSize * 0.8, 6, 4),
                new THREE.MeshStandardMaterial({
                    color: 0x999999, transparent: true, opacity: 0.2, roughness: 1.0,
                })
            );
            shadowPuff.position.y = -baseSize * 0.3;
            shadowPuff.scale.y = 0.2;
            cloudGroup.add(shadowPuff);

            cloudGroup.position.set(
                (Math.random() - 0.5) * 140,
                18 + Math.random() * 25,
                -35 - Math.random() * 50
            );
            this.scene.add(cloudGroup);
            this.clouds.push({
                group: cloudGroup,
                speed: 0.2 + Math.random() * 0.4,
                baseX: cloudGroup.position.x,
            });
        }
    }

    /* ========================================================
     *  PARALLAX LAYERS - 6層の背景（砂漠テーマ強化）
     * ======================================================== */
    _buildParallaxLayers() {
        // 写真背景モード: 建築物パララックスを使わず、同一画像で前景までカバー
        if (this.backgroundPhotoUrl) {
            this._buildPhotoForegroundLayers();
            return;
        }

        // Layer 0: 最遠景 - ピラミッド群 (Z=-85, rate=0.02)
        this._buildDistantPyramids(-85, 0.02);
        // Layer 1: 最遠景 - 山脈/砂丘シルエット (Z=-70, rate=0.05)
        this._buildDistantMountains(-70, 0.05);
        // Layer 2: 遠景 - 大きな建物・工場・遺跡 (Z=-45, rate=0.15)
        this._buildDistantBuildings(-45, 0.15);
        // Layer 3: 中景 - 石造り建物群・監視塔・オベリスク (Z=-22, rate=0.35)
        this._buildMidgroundBuildings(-22, 0.35);
        // Layer 4: 近景 - 鉄骨構造物・電柱・ヤシの木 (Z=-10, rate=0.55)
        this._buildForegroundStructures(-10, 0.55);
        // Layer 5: 最前景 - 壊れた車両・瓦礫・岩 (Z=-4, rate=0.75)
        this._buildNearForeground(-4, 0.75);
    }

    _buildPhotoForegroundLayers() {
        const mat = new THREE.MeshBasicMaterial({
            color: 0xFFFFFF,
            transparent: true,
            opacity: 0.96,
            side: THREE.DoubleSide,
            depthWrite: false,
            fog: false,
        });

        // 画面手前左右を同一画像で埋める大型ウォール
        for (const side of [-1, 1]) {
            const wall = new THREE.Mesh(new THREE.PlaneGeometry(260, 62), mat.clone());
            wall.position.set(side * 44, 20, 0);
            wall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
            this.scene.add(wall);
            this.photoForegroundMeshes.push({ mesh: wall, baseX: wall.position.x });
        }

        // 手前中央下を埋める低い前面パネル（地平線付近の切れ目防止）
        const front = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), mat.clone());
        front.position.set(0, 11, 56);
        front.rotation.y = Math.PI;
        this.scene.add(front);
        this.photoForegroundMeshes.push({ mesh: front, baseX: 0, isFront: true });
    }

    /* --- Layer 0: 最遠景のピラミッド群（Metal Slug砂漠ステージの象徴） --- */
    _buildDistantPyramids(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        // 大きなピラミッドを散在させる
        for (let i = -3; i <= 6; i++) {
            const pGroup = new THREE.Group();
            const height = 18 + Math.random() * 14;
            const base = height * 1.35;

            // メインのピラミッド（4面の正方錐台）
            const pyrGeo = new THREE.ConeGeometry(base / 2, height, 4);
            const sandColor = new THREE.Color().setHSL(
                0.1 + Math.random() * 0.03,
                0.50 + Math.random() * 0.12,
                0.55 + Math.random() * 0.10
            );
            const pyrMat = new THREE.MeshStandardMaterial({
                color: sandColor,
                roughness: 0.92,
                metalness: 0.0,
                flatShading: true,
            });
            const pyramid = new THREE.Mesh(pyrGeo, pyrMat);
            pyramid.rotation.y = Math.PI / 4; // 角を手前に
            pyramid.position.y = height / 2;
            pGroup.add(pyramid);

            // ピラミッド下部の陰影（砂埃がかかったような暗部）
            const shadowGeo = new THREE.ConeGeometry(base / 2 + 0.1, height * 0.3, 4);
            const shadow = new THREE.Mesh(
                shadowGeo,
                new THREE.MeshStandardMaterial({
                    color: sandColor.clone().multiplyScalar(0.75),
                    roughness: 0.95, flatShading: true,
                })
            );
            shadow.rotation.y = Math.PI / 4;
            shadow.position.y = height * 0.15;
            pGroup.add(shadow);

            // 頂上の摩耗（一部欠けた様子）
            if (Math.random() > 0.5) {
                const capGeo = new THREE.BoxGeometry(base * 0.08, base * 0.06, base * 0.08);
                const cap = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({
                    color: sandColor.clone().multiplyScalar(1.1),
                    roughness: 0.9,
                }));
                cap.position.y = height + 0.1;
                cap.rotation.y = Math.PI / 4;
                pGroup.add(cap);
            }

            pGroup.position.set(
                i * 35 + (Math.random() - 0.5) * 14,
                0,
                zPos + (Math.random() - 0.5) * 18
            );
            this.scene.add(pGroup);
            layer.objects.push(pGroup);
        }
        this.bgLayers.push(layer);
    }

    /* --- Layer 1: 最遠景の砂丘/岩山シルエット（砂漠仕様） --- */
    _buildDistantMountains(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -4; i <= 8; i++) {
            const mtnGroup = new THREE.Group();
            const isDune = Math.random() > 0.4;
            const height = isDune ? (6 + Math.random() * 8) : (12 + Math.random() * 14);
            const width = 18 + Math.random() * 18;

            // メイン山体（砂丘は低く広く、岩山は高く鋭く）
            let mtnGeo;
            if (isDune) {
                // 砂丘: 丸みのあるシェイプを作成
                const duneShape = new THREE.Shape();
                duneShape.moveTo(-width / 2, 0);
                const steps = 10;
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const x = (t - 0.5) * width;
                    const y = Math.sin(t * Math.PI) * height * (0.9 + Math.random() * 0.1);
                    duneShape.lineTo(x, y);
                }
                duneShape.lineTo(width / 2, 0);
                duneShape.lineTo(-width / 2, 0);
                mtnGeo = new THREE.ExtrudeGeometry(duneShape, { depth: 1, bevelEnabled: false });
            } else {
                // 岩山: 不規則なコーン
                mtnGeo = new THREE.ConeGeometry(width / 2, height, 5 + Math.floor(Math.random() * 3));
            }

            // 砂漠色のカラーパレット（タン/黄土色/茶色）
            const palettes = [
                { h: 0.10, s: 0.42, l: 0.42 }, // タン
                { h: 0.08, s: 0.48, l: 0.45 }, // 黄土色
                { h: 0.06, s: 0.38, l: 0.38 }, // 赤茶
                { h: 0.09, s: 0.32, l: 0.33 }, // 暗い土
            ];
            const p = palettes[Math.floor(Math.random() * palettes.length)];
            const mtnMat = new THREE.MeshStandardMaterial({
                color: new THREE.Color().setHSL(p.h, p.s, p.l),
                roughness: 0.98, metalness: 0.0,
                flatShading: !isDune,
            });
            const mountain = new THREE.Mesh(mtnGeo, mtnMat);
            if (!isDune) {
                mountain.position.y = height / 2;
            }
            mtnGroup.add(mountain);

            // 岩山の影面（陰影を強調）
            if (!isDune && Math.random() > 0.4) {
                const stripeGeo = new THREE.ConeGeometry(width / 2 - 0.5, height * 0.7, 5);
                const stripe = new THREE.Mesh(
                    stripeGeo,
                    new THREE.MeshStandardMaterial({
                        color: new THREE.Color().setHSL(p.h, p.s * 0.9, p.l * 0.75),
                        roughness: 0.95, flatShading: true,
                    })
                );
                stripe.position.set(-0.4, height * 0.3, 0.3);
                mtnGroup.add(stripe);
            }

            mtnGroup.position.set(
                i * 22 + (Math.random() - 0.5) * 10,
                0,
                zPos + (Math.random() - 0.5) * 12
            );
            this.scene.add(mtnGroup);
            layer.objects.push(mtnGroup);
        }
        this.bgLayers.push(layer);
    }

    /* --- Layer 2: 遠景の大きな建物・工場 --- */
    _buildDistantBuildings(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -3; i <= 7; i++) {
            const bGroup = new THREE.Group();
            const type = Math.floor(Math.random() * 5);

            if (type <= 1) {
                // 大きな工場/倉庫
                this._buildFactory(bGroup);
            } else if (type === 2) {
                // 給水塔
                this._buildWaterTower(bGroup);
            } else if (type === 3) {
                // 煙突付き工場
                this._buildChimneyFactory(bGroup);
            } else {
                // 大きな廃墟ビル
                this._buildRuinedHighrise(bGroup);
            }

            bGroup.position.set(
                i * 28 + (Math.random() - 0.5) * 12,
                0,
                zPos + (Math.random() - 0.5) * 8
            );
            this.scene.add(bGroup);
            layer.objects.push(bGroup);
        }
        this.bgLayers.push(layer);
    }

    _buildFactory(group) {
        const w = 8 + Math.random() * 5;
        const h = 4 + Math.random() * 3;
        const bodyGeo = new THREE.BoxGeometry(w, h, 5);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x787868, roughness: 0.82, metalness: 0.12,
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.y = h / 2;
        group.add(body);

        // 屋根（三角）
        const roofShape = new THREE.Shape();
        roofShape.moveTo(-w / 2 - 0.3, 0);
        roofShape.lineTo(0, 2.5);
        roofShape.lineTo(w / 2 + 0.3, 0);
        const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 5.5, bevelEnabled: false });
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: 0x9A5020, roughness: 0.85,
        }));
        roof.position.set(0, h, -2.75);
        group.add(roof);

        // 窓
        const winMat = new THREE.MeshStandardMaterial({ color: 0x222233, roughness: 0.3 });
        for (let wy = 1.5; wy < h - 0.5; wy += 2.5) {
            for (let wx = -w / 2 + 1.5; wx < w / 2 - 0.5; wx += 2.0) {
                if (Math.random() > 0.3) {
                    const win = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.2, 0.2), winMat);
                    win.position.set(wx, wy, 2.6);
                    group.add(win);
                }
            }
        }
    }

    _buildWaterTower(group) {
        const legMat = new THREE.MeshStandardMaterial({
            color: 0x5A5A5A, roughness: 0.6, metalness: 0.4,
        });
        for (let lx = -1.2; lx <= 1.2; lx += 2.4) {
            for (let lz = -0.6; lz <= 0.6; lz += 1.2) {
                const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 8, 6), legMat);
                leg.position.set(lx, 4, lz);
                group.add(leg);
            }
        }
        // 横梁
        for (let h = 2; h <= 6; h += 4) {
            for (let z of [-0.6, 0.6]) {
                const brace = new THREE.Mesh(
                    new THREE.BoxGeometry(2.8, 0.08, 0.08),
                    legMat
                );
                brace.position.set(0, h, z);
                group.add(brace);
            }
        }
        const tankGeo = new THREE.CylinderGeometry(1.8, 1.8, 2.5, 12);
        const tank = new THREE.Mesh(tankGeo, new THREE.MeshStandardMaterial({
            color: 0x7B8B7B, roughness: 0.5, metalness: 0.3,
        }));
        tank.position.y = 9.5;
        group.add(tank);
        // タンク上部の蓋
        const lid = new THREE.Mesh(
            new THREE.ConeGeometry(2.0, 1.0, 12),
            new THREE.MeshStandardMaterial({ color: 0x6B7B6B, roughness: 0.6 })
        );
        lid.position.y = 11.2;
        group.add(lid);
    }

    _buildChimneyFactory(group) {
        // 本体
        const bodyGeo = new THREE.BoxGeometry(6, 5, 4);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.85,
        }));
        body.position.y = 2.5;
        group.add(body);

        // 煙突（2本）
        for (let x of [-1.5, 1.5]) {
            const chimney = new THREE.Mesh(
                new THREE.CylinderGeometry(0.4, 0.5, 8, 8),
                new THREE.MeshStandardMaterial({ color: 0x8B5A2B, roughness: 0.7, metalness: 0.2 })
            );
            chimney.position.set(x, 9, 0);
            group.add(chimney);

            // 煙突の上部リング
            const ring = new THREE.Mesh(
                new THREE.TorusGeometry(0.5, 0.08, 6, 12),
                new THREE.MeshStandardMaterial({ color: 0x5A4A3A, metalness: 0.3 })
            );
            ring.position.set(x, 13, 0);
            ring.rotation.x = Math.PI / 2;
            group.add(ring);
        }

        // パイプ
        const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.2, 4, 6),
            new THREE.MeshStandardMaterial({ color: 0x6A6A5A, metalness: 0.4 })
        );
        pipe.position.set(3.2, 3, 0);
        pipe.rotation.z = 0.3;
        group.add(pipe);
    }

    _buildRuinedHighrise(group) {
        const h = 8 + Math.random() * 8;
        const w = 4 + Math.random() * 3;
        const bodyGeo = new THREE.BoxGeometry(w, h, 3.5);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x8B7B6B, roughness: 0.9,
        }));
        body.position.y = h / 2;
        group.add(body);

        // 窓の穴（暗い四角）
        const winMat = new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 0.5 });
        for (let wy = 1.5; wy < h - 1; wy += 2.0) {
            for (let wx = -w / 3; wx <= w / 3; wx += w / 3) {
                if (Math.random() > 0.25) {
                    const win = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.3), winMat);
                    win.position.set(wx, wy, 1.8);
                    group.add(win);
                }
            }
        }

        // 崩れた上部（不規則な形）
        if (Math.random() > 0.4) {
            const debrisGeo = new THREE.BoxGeometry(w * 0.6, 1.5, 2);
            const debris = new THREE.Mesh(debrisGeo, new THREE.MeshStandardMaterial({
                color: 0x7B6B5B, roughness: 0.95,
            }));
            debris.position.set((Math.random() - 0.5) * w * 0.3, h + 0.5, 0);
            debris.rotation.z = (Math.random() - 0.5) * 0.3;
            group.add(debris);
        }
    }

    /* --- Layer 3: 中景の石造り建物群・監視塔・砂漠遺跡・アラビア風街並み --- */
    _buildMidgroundBuildings(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        // アラビア風建築の比率を上げるため、i=-4..8 に拡張して密度アップ
        for (let i = -4; i <= 8; i++) {
            const bGroup = new THREE.Group();
            // 0-11 の12種：後半8種はアラビア/砂漠町並み系
            const type = Math.floor(Math.random() * 14);

            if (type === 0) {
                this._buildStoneBuilding(bGroup);
            } else if (type === 1) {
                this._buildWatchTower(bGroup);
            } else if (type === 2) {
                this._buildWarehouse(bGroup);
            } else if (type === 3) {
                this._buildFortWall(bGroup);
            } else if (type === 4) {
                this._buildDesertRuins(bGroup);
            } else if (type === 5) {
                this._buildObelisk(bGroup);
            } else if (type <= 7) {
                // アラビア風二連オニオンドーム寺院
                this._buildArabianTemple(bGroup);
            } else if (type <= 9) {
                // 岩壁アドベ民家（縞ひさし・果物籠付き）
                this._buildAdobeHouse(bGroup);
            } else if (type === 10) {
                // バザール（縞テント・果物台）
                this._buildBazaarStall(bGroup);
            } else if (type === 11) {
                // 大モスク（中央大ドーム＋角ミナレット）
                this._buildGrandMosque(bGroup);
            } else if (type === 12) {
                // アラビア門（青旗・書法バナー）
                this._buildArabianGate(bGroup);
            } else {
                this._buildDesertTemple(bGroup);
            }

            bGroup.position.set(
                i * 20 + (Math.random() - 0.5) * 9,
                0,
                zPos + (Math.random() - 0.5) * 5
            );
            this.scene.add(bGroup);
            layer.objects.push(bGroup);
        }
        this.bgLayers.push(layer);
    }

    /* ========================================================
     *  アラビア建築ヘルパー
     * ======================================================== */
    /** オニオンドーム（玉ねぎ形ドーム）— Lathe で球根状のプロファイルを作る */
    _buildOnionDome(baseR, totalH, color, segments = 18) {
        const points = [];
        points.push(new THREE.Vector2(baseR * 0.58, 0));
        points.push(new THREE.Vector2(baseR * 0.88, totalH * 0.06));
        points.push(new THREE.Vector2(baseR * 1.12, totalH * 0.22));
        points.push(new THREE.Vector2(baseR * 1.22, totalH * 0.38));
        points.push(new THREE.Vector2(baseR * 1.08, totalH * 0.52));
        points.push(new THREE.Vector2(baseR * 0.78, totalH * 0.66));
        points.push(new THREE.Vector2(baseR * 0.45, totalH * 0.80));
        points.push(new THREE.Vector2(baseR * 0.18, totalH * 0.92));
        points.push(new THREE.Vector2(0, totalH));
        const geo = new THREE.LatheGeometry(points, segments);
        const mat = new THREE.MeshStandardMaterial({
            color, roughness: 0.68, metalness: 0.12,
        });
        return new THREE.Mesh(geo, mat);
    }

    /** ドーム金スパイア（先端装飾）— 細い棒＋玉＋三日月 */
    _buildDomeFinial(y, x = 0, z = 0) {
        const group = new THREE.Group();
        const goldMat = new THREE.MeshStandardMaterial({
            color: 0xCA9B3C, metalness: 0.75, roughness: 0.3,
            emissive: 0x4a3010, emissiveIntensity: 0.15,
        });
        const rod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.05, 0.9, 6), goldMat
        );
        rod.position.set(x, y + 0.45, z);
        group.add(rod);
        const ball = new THREE.Mesh(
            new THREE.SphereGeometry(0.12, 8, 6), goldMat
        );
        ball.position.set(x, y + 1.0, z);
        group.add(ball);
        const cres = new THREE.Mesh(
            new THREE.TorusGeometry(0.14, 0.035, 6, 12, Math.PI * 1.1),
            goldMat
        );
        cres.position.set(x, y + 1.28, z);
        cres.rotation.x = Math.PI / 2;
        cres.rotation.z = -Math.PI / 2;
        group.add(cres);
        return group;
    }

    /** 尖頭アーチ開口部（暗いボックス＋上部の尖った台形）— 砂漠建築のドア/窓 */
    _buildPointedArch(w, h, depth = 0.12, color = 0x1E1008) {
        const group = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
        // 下部矩形
        const rect = new THREE.Mesh(
            new THREE.BoxGeometry(w, h * 0.72, depth), mat
        );
        rect.position.y = h * 0.36;
        group.add(rect);
        // 上部の尖り（三角錐をスケール）
        const tip = new THREE.Mesh(
            new THREE.ConeGeometry(w / 2, h * 0.38, 4, 1), mat
        );
        tip.position.y = h * 0.72 + h * 0.19;
        tip.rotation.y = Math.PI / 4;
        tip.scale.z = depth / (w / Math.SQRT2);
        group.add(tip);
        return group;
    }

    /** 書法風バナー（青地＋クリーム縁＋書法を模した不規則ストローク） */
    _buildCalligraphyBanner(w, h, y, z) {
        const group = new THREE.Group();
        // 背景
        const bg = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 0.08),
            new THREE.MeshStandardMaterial({ color: 0x3A5F8A, roughness: 0.85 })
        );
        bg.position.set(0, y, z);
        group.add(bg);
        // 上下クリーム縁
        for (const yOff of [h / 2 - 0.05, -h / 2 + 0.05]) {
            const border = new THREE.Mesh(
                new THREE.BoxGeometry(w, 0.07, 0.1),
                new THREE.MeshStandardMaterial({ color: 0xEEDCAA, roughness: 0.7 })
            );
            border.position.set(0, y + yOff, z + 0.02);
            group.add(border);
        }
        // 書法ストローク（クリーム色で不規則な縦横線）
        const ink = new THREE.MeshBasicMaterial({ color: 0xF0DDB0 });
        const glyphCount = Math.floor(w * 2.2);
        for (let g = 0; g < glyphCount; g++) {
            const gx = -w / 2 + 0.25 + (g / glyphCount) * (w - 0.5);
            // 縦ストローク
            const vs = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, h * 0.5 * (0.6 + Math.random() * 0.4), 0.03),
                ink
            );
            vs.position.set(gx, y + (Math.random() - 0.5) * 0.08, z + 0.06);
            vs.rotation.z = (Math.random() - 0.5) * 0.2;
            group.add(vs);
            // 横/曲線ストローク（確率で）
            if (Math.random() > 0.5) {
                const hs = new THREE.Mesh(
                    new THREE.BoxGeometry(0.18, 0.05, 0.03),
                    ink
                );
                hs.position.set(gx + 0.04, y + (Math.random() - 0.5) * 0.25, z + 0.06);
                hs.rotation.z = (Math.random() - 0.5) * 0.5;
                group.add(hs);
            }
            // ドット（点）
            if (Math.random() > 0.7) {
                const dot = new THREE.Mesh(
                    new THREE.BoxGeometry(0.07, 0.07, 0.03), ink
                );
                dot.position.set(gx, y + h / 2 - 0.15, z + 0.06);
                group.add(dot);
            }
        }
        return group;
    }

    /** 縞模様のオーニング（テント屋根）— stripes×2色で層状に */
    _buildStripedAwning(width, depth, colorA, colorB, stripes = 8) {
        const group = new THREE.Group();
        const stripeW = depth / stripes;
        for (let i = 0; i < stripes; i++) {
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(width, 0.04, stripeW + 0.01),
                new THREE.MeshStandardMaterial({
                    color: i % 2 === 0 ? colorA : colorB,
                    roughness: 0.82, side: THREE.DoubleSide,
                })
            );
            stripe.position.set(0, -i * 0.015, -depth / 2 + stripeW / 2 + i * stripeW);
            group.add(stripe);
        }
        // スカロップ（波状）の前縁
        const scallopColor = new THREE.MeshStandardMaterial({ color: colorA, roughness: 0.85 });
        const scallopCount = Math.floor(width / 0.35);
        for (let s = 0; s < scallopCount; s++) {
            const sc = new THREE.Mesh(
                new THREE.ConeGeometry(0.18, 0.3, 3, 1),
                scallopColor
            );
            sc.position.set(-width / 2 + 0.18 + s * (width / scallopCount), -0.15, depth / 2);
            sc.rotation.x = Math.PI;
            sc.scale.set(1, 1, 0.35);
            group.add(sc);
        }
        return group;
    }

    /* --- アラビア風寺院（概念画像の二連オニオンドーム） --- */
    _buildArabianTemple(group) {
        const wallColor = 0xDEBA7F;
        const wallColorDk = 0xB89366;
        const domeColor = 0x8C3B1C;    // テラコッタ（玉ねぎドーム）
        const domeShadow = 0x5E2613;
        const trimColor = 0x7A4A2A;
        const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.92 });
        const wallMatDk = new THREE.MeshStandardMaterial({ color: wallColorDk, roughness: 0.92 });
        const trimMat = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.85 });

        const w = 6.0, h = 4.8, d = 3.8;

        // 基壇（台石）
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.8, 0.4, d + 0.5), trimMat
        );
        base.position.y = 0.2;
        group.add(base);

        // 本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        body.position.y = 0.4 + h / 2;
        group.add(body);

        // コーニス（装飾的な上縁、二段）
        const cornice1 = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.4, 0.25, d + 0.3), trimMat
        );
        cornice1.position.y = 0.4 + h - 0.15;
        group.add(cornice1);
        const cornice2 = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.6, 0.2, d + 0.4), wallMatDk
        );
        cornice2.position.y = 0.4 + h + 0.1;
        group.add(cornice2);

        // 胸壁の矩形装飾（階段状）
        for (let cx = -w / 2 + 0.3; cx < w / 2; cx += 0.6) {
            const merlon = new THREE.Mesh(
                new THREE.BoxGeometry(0.3, 0.3, 0.3), trimMat
            );
            merlon.position.set(cx, 0.4 + h + 0.35, d / 2 + 0.1);
            group.add(merlon);
        }

        // 中央の尖頭アーチ入り口
        const entrance = this._buildPointedArch(1.6, 2.8, 0.15, 0x2B1A0F);
        entrance.position.set(0, 0.4, d / 2 + 0.01);
        group.add(entrance);

        // 入り口の石枠（トリム）
        const doorFrame = new THREE.Mesh(
            new THREE.BoxGeometry(1.85, 0.15, 0.15), trimMat
        );
        doorFrame.position.set(0, 0.4 + 2.85, d / 2 + 0.08);
        group.add(doorFrame);
        for (const sx of [-0.9, 0.9]) {
            const side = new THREE.Mesh(
                new THREE.BoxGeometry(0.15, 2.4, 0.15), trimMat
            );
            side.position.set(sx, 0.4 + 1.25, d / 2 + 0.08);
            group.add(side);
        }

        // 書法バナー（入り口上）
        const banner = this._buildCalligraphyBanner(4.6, 0.7, 0.4 + h - 0.9, d / 2 + 0.1);
        group.add(banner);

        // 小さな尖頭アーチ窓（左右）
        for (const sx of [-2.0, 2.0]) {
            const win = this._buildPointedArch(0.55, 1.1, 0.1, 0x1A1020);
            win.position.set(sx, 0.4 + 0.9, d / 2 + 0.01);
            group.add(win);
            // 窓枠
            const frame = new THREE.Mesh(
                new THREE.BoxGeometry(0.7, 0.05, 0.1), trimMat
            );
            frame.position.set(sx, 0.4 + 2.0, d / 2 + 0.05);
            group.add(frame);
        }

        // 装飾タイル帯（本体中ほどに細い青帯）
        const tileBand = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.05, 0.12, d + 0.05),
            new THREE.MeshStandardMaterial({ color: 0x2E4D78, roughness: 0.5 })
        );
        tileBand.position.y = 0.4 + h * 0.35;
        group.add(tileBand);

        // 二連のオニオンドーム（本命）
        for (const dx of [-1.55, 1.55]) {
            // ドラム（ドーム下の円筒）
            const drum = new THREE.Mesh(
                new THREE.CylinderGeometry(0.95, 1.0, 0.8, 14), trimMat
            );
            drum.position.set(dx, 0.4 + h + 0.6, 0);
            group.add(drum);
            // ドラムの窓スリット（アーチ窓風）
            for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 4) {
                const slit = new THREE.Mesh(
                    new THREE.BoxGeometry(0.18, 0.45, 0.06),
                    new THREE.MeshStandardMaterial({ color: 0x1E1208 })
                );
                slit.position.set(
                    dx + Math.cos(ang) * 1.01,
                    0.4 + h + 0.6,
                    Math.sin(ang) * 1.01
                );
                slit.rotation.y = -ang + Math.PI / 2;
                group.add(slit);
            }

            // 本体のオニオンドーム
            const dome = this._buildOnionDome(1.1, 3.2, domeColor);
            dome.position.set(dx, 0.4 + h + 1.0, 0);
            group.add(dome);

            // 縦のリブ（ドーム面の縫い目）
            for (let r = 0; r < 10; r++) {
                const ang = (r / 10) * Math.PI * 2;
                const rib = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 2.8, 0.04),
                    new THREE.MeshStandardMaterial({ color: domeShadow, roughness: 0.8 })
                );
                rib.position.set(
                    dx + Math.cos(ang) * 0.95,
                    0.4 + h + 2.2,
                    Math.sin(ang) * 0.95
                );
                rib.rotation.z = 0.08 * Math.cos(ang);
                rib.rotation.x = 0.08 * Math.sin(ang);
                group.add(rib);
            }

            // 先端装飾
            group.add(this._buildDomeFinial(0.4 + h + 4.2, dx, 0));
        }

        // 正面の縞オーニング（入り口ひさし）
        const awning = this._buildStripedAwning(2.4, 1.4, 0xD64A22, 0xEED67A, 6);
        awning.position.set(0, 0.4 + 3.1, d / 2 + 0.35);
        awning.rotation.x = -0.4;
        group.add(awning);

        // 入り口両脇のランタン
        for (const lx of [-1.0, 1.0]) {
            const hook = new THREE.Mesh(
                new THREE.CylinderGeometry(0.02, 0.02, 0.25, 4),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            hook.position.set(lx, 0.4 + 2.7, d / 2 + 0.2);
            group.add(hook);
            const lantern = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.14, 0.32, 8),
                new THREE.MeshStandardMaterial({
                    color: 0xFFCC66, emissive: 0xE88822,
                    emissiveIntensity: 0.55, roughness: 0.5,
                })
            );
            lantern.position.set(lx, 0.4 + 2.4, d / 2 + 0.2);
            group.add(lantern);
        }
    }

    /* --- アドベ（土+岩）民家：縞ひさし・果物籠付き --- */
    _buildAdobeHouse(group) {
        const adobe = new THREE.MeshStandardMaterial({
            color: 0xC28E5A, roughness: 0.95, flatShading: true,
        });
        const adobeDk = new THREE.MeshStandardMaterial({
            color: 0x8E5C34, roughness: 0.96, flatShading: true,
        });
        const adobeLt = new THREE.MeshStandardMaterial({
            color: 0xD8A878, roughness: 0.94, flatShading: true,
        });

        const w = 5.2, h = 3.6, d = 3.4;

        // 1階本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), adobe);
        body.position.y = h / 2;
        group.add(body);

        // ランダムな岩ブロック（質感出し）
        for (let i = 0; i < 14; i++) {
            const sz = 0.35 + Math.random() * 0.35;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.7, sz * 0.55),
                [adobeLt, adobeDk, adobe][Math.floor(Math.random() * 3)]
            );
            rock.position.set(
                -w / 2 + Math.random() * w,
                0.2 + Math.random() * (h - 0.3),
                d / 2 + 0.0
            );
            rock.rotation.y = (Math.random() - 0.5) * 0.4;
            rock.rotation.z = (Math.random() - 0.5) * 0.2;
            group.add(rock);
        }

        // 2階（セットバック）
        const upperW = w * 0.62;
        const upperH = 2.2;
        const upper = new THREE.Mesh(
            new THREE.BoxGeometry(upperW, upperH, d), adobeDk
        );
        upper.position.set(w * 0.12, h + upperH / 2, 0);
        group.add(upper);
        // 2階の岩質感
        for (let i = 0; i < 7; i++) {
            const sz = 0.3 + Math.random() * 0.25;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.6, sz * 0.5),
                Math.random() > 0.5 ? adobeLt : adobe
            );
            rock.position.set(
                w * 0.12 - upperW / 2 + Math.random() * upperW,
                h + 0.15 + Math.random() * (upperH - 0.3),
                d / 2 + 0.0
            );
            group.add(rock);
        }

        // 1階の尖頭アーチ扉
        const door = this._buildPointedArch(1.1, 2.2, 0.12, 0x1E1008);
        door.position.set(-w * 0.22, 0, d / 2 + 0.01);
        group.add(door);

        // 扉上の縞オーニング（オレンジ×クリーム）
        const awning = this._buildStripedAwning(1.9, 1.0, 0xD94E22, 0xE8C16A, 6);
        awning.position.set(-w * 0.22, 2.55, d / 2 + 0.3);
        awning.rotation.x = -0.38;
        group.add(awning);

        // 小さな尖頭アーチ窓（1階・2階）
        const blueShutter = new THREE.MeshStandardMaterial({ color: 0x2F4E72, roughness: 0.8 });
        for (const sx of [w * 0.28, -w * 0.42]) {
            const win = this._buildPointedArch(0.5, 0.9, 0.08, 0x1A1020);
            win.position.set(sx, 1.95, d / 2 + 0.02);
            group.add(win);
            // 青い鎧戸
            for (const side of [-1, 1]) {
                const sh = new THREE.Mesh(
                    new THREE.BoxGeometry(0.28, 0.95, 0.04), blueShutter
                );
                sh.position.set(sx + side * 0.38, 2.25, d / 2 + 0.09);
                sh.rotation.y = side * 0.15;
                group.add(sh);
            }
        }
        // 2階の小さな窓
        const upperWin = this._buildPointedArch(0.45, 0.7, 0.08, 0x1A1020);
        upperWin.position.set(w * 0.12, h + 0.8, d / 2 + 0.02);
        group.add(upperWin);

        // 2階の小バルコニー
        const balcony = new THREE.Mesh(
            new THREE.BoxGeometry(upperW * 0.7, 0.15, 0.5), adobeLt
        );
        balcony.position.set(w * 0.12, h + 0.3, d / 2 + 0.25);
        group.add(balcony);
        // バルコニー手すり
        for (let bx = -upperW * 0.3; bx <= upperW * 0.3; bx += 0.2) {
            const bal = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, 0.5, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x5A3A1A })
            );
            bal.position.set(w * 0.12 + bx, h + 0.6, d / 2 + 0.45);
            group.add(bal);
        }

        // フラット屋根＋パラペット
        const roof = new THREE.Mesh(
            new THREE.BoxGeometry(upperW + 0.2, 0.15, d + 0.2), adobeDk
        );
        roof.position.set(w * 0.12, h + upperH + 0.1, 0);
        group.add(roof);
        for (let rx = -upperW / 2; rx < upperW / 2; rx += 0.4) {
            if (Math.random() > 0.25) {
                const pblock = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3, 0.25, 0.3), adobeLt
                );
                pblock.position.set(w * 0.12 + rx, h + upperH + 0.3, d / 2);
                group.add(pblock);
            }
        }

        // 屋根上の物干し/鉢（確率）
        if (Math.random() > 0.5) {
            const pot = new THREE.Mesh(
                new THREE.CylinderGeometry(0.15, 0.2, 0.25, 8),
                new THREE.MeshStandardMaterial({ color: 0x8B4A22, roughness: 0.9 })
            );
            pot.position.set(w * 0.3, h + upperH + 0.35, -0.2);
            group.add(pot);
            const plant = new THREE.Mesh(
                new THREE.SphereGeometry(0.2, 6, 4),
                new THREE.MeshStandardMaterial({ color: 0x3B6A2A, roughness: 0.9 })
            );
            plant.position.set(w * 0.3, h + upperH + 0.6, -0.2);
            plant.scale.y = 0.7;
            group.add(plant);
        }

        // 前面の果物籠（オレンジ山積み）
        for (let k = 0; k < 2; k++) {
            const cx = -w * 0.55 + k * 0.85;
            const crate = new THREE.Mesh(
                new THREE.BoxGeometry(0.55, 0.45, 0.55),
                new THREE.MeshStandardMaterial({ color: 0x7B5A2A, roughness: 0.9 })
            );
            crate.position.set(cx, 0.225, d / 2 + 0.5);
            group.add(crate);
            // オレンジ山
            for (let o = 0; o < 6; o++) {
                const orange = new THREE.Mesh(
                    new THREE.SphereGeometry(0.11, 6, 5),
                    new THREE.MeshStandardMaterial({
                        color: 0xE87838, roughness: 0.75, emissive: 0x3a1a08,
                    })
                );
                orange.position.set(
                    cx + (Math.random() - 0.5) * 0.35,
                    0.52 + Math.floor(o / 3) * 0.18,
                    d / 2 + 0.5 + (Math.random() - 0.5) * 0.35
                );
                group.add(orange);
            }
        }

        // 入り口脇の壺
        const jar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.15, 0.7, 8),
            new THREE.MeshStandardMaterial({ color: 0x7A4E22, roughness: 0.9 })
        );
        jar.position.set(w * 0.1, 0.35, d / 2 + 0.35);
        group.add(jar);
        const jarNeck = new THREE.Mesh(
            new THREE.CylinderGeometry(0.1, 0.15, 0.2, 8),
            new THREE.MeshStandardMaterial({ color: 0x5A3A18, roughness: 0.9 })
        );
        jarNeck.position.set(w * 0.1, 0.8, d / 2 + 0.35);
        group.add(jarNeck);
    }

    /* --- バザール（縞テント屋台） --- */
    _buildBazaarStall(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xCFA870, roughness: 0.93,
        });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x7A4A22, roughness: 0.9 });

        // 後ろの壁（アドベ）
        const wall = new THREE.Mesh(
            new THREE.BoxGeometry(5.2, 3.6, 1.6), wallMat
        );
        wall.position.set(0, 1.8, -0.8);
        group.add(wall);
        // 壁の粗い岩質感
        for (let i = 0; i < 8; i++) {
            const sz = 0.3 + Math.random() * 0.3;
            const rock = new THREE.Mesh(
                new THREE.BoxGeometry(sz, sz * 0.65, sz * 0.45),
                new THREE.MeshStandardMaterial({
                    color: [0xB88A58, 0xD8A878, 0x8C5A30][Math.floor(Math.random() * 3)],
                    roughness: 0.95, flatShading: true,
                })
            );
            rock.position.set(
                -2.2 + Math.random() * 4.4, 0.2 + Math.random() * 3.3, -0.0
            );
            group.add(rock);
        }

        // 前面の柱（屋根を支える）
        for (const px of [-2.4, 2.4]) {
            const post = new THREE.Mesh(
                new THREE.CylinderGeometry(0.12, 0.14, 2.8, 6), woodMat
            );
            post.position.set(px, 1.4, 1.2);
            group.add(post);
        }

        // 大きな縞オーニング（赤×黄）
        const awning = this._buildStripedAwning(5.2, 2.4, 0xCB3E1A, 0xF0D260, 10);
        awning.position.set(0, 2.85, 0.6);
        awning.rotation.x = -0.28;
        group.add(awning);

        // カウンター
        const counter = new THREE.Mesh(
            new THREE.BoxGeometry(4.8, 0.7, 1.0), woodMat
        );
        counter.position.set(0, 0.35, 1.1);
        group.add(counter);

        // カウンター上の果物ピラミッド
        const fruitPalette = [
            { color: 0xE87838, ems: 0x4a1a08 },   // オレンジ
            { color: 0xD8422A, ems: 0x4a0a04 },   // トマト/ザクロ
            { color: 0xEBC44A, ems: 0x4a3010 },   // レモン
            { color: 0x6BA838, ems: 0x1a3a08 },   // ライム/スイカ
        ];
        for (let col = 0; col < 4; col++) {
            const fp = fruitPalette[col];
            const fx = -1.8 + col * 1.2;
            // ピラミッド3段
            for (let layer2 = 0; layer2 < 3; layer2++) {
                const count = 3 - layer2;
                for (let k = 0; k < count; k++) {
                    const fruit = new THREE.Mesh(
                        new THREE.SphereGeometry(0.12, 6, 5),
                        new THREE.MeshStandardMaterial({
                            color: fp.color, roughness: 0.7,
                            emissive: fp.ems, emissiveIntensity: 0.15,
                        })
                    );
                    fruit.position.set(
                        fx + (k - (count - 1) / 2) * 0.22 + layer2 * 0.05,
                        0.83 + layer2 * 0.2,
                        1.1 + (Math.random() - 0.5) * 0.1
                    );
                    group.add(fruit);
                }
            }
        }

        // 吊りランタン×3
        for (const lx of [-1.6, 0, 1.6]) {
            const str = new THREE.Mesh(
                new THREE.CylinderGeometry(0.015, 0.015, 0.35, 3),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            str.position.set(lx, 2.3, 1.1);
            group.add(str);
            const lantern = new THREE.Mesh(
                new THREE.CylinderGeometry(0.13, 0.16, 0.35, 8),
                new THREE.MeshStandardMaterial({
                    color: 0xFFCC66, emissive: 0xE8A024,
                    emissiveIntensity: 0.55, roughness: 0.5,
                })
            );
            lantern.position.set(lx, 1.95, 1.1);
            group.add(lantern);
            // 上下のキャップ
            const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.08, 0.13, 0.06, 8),
                new THREE.MeshStandardMaterial({ color: 0x5A3A1A })
            );
            cap.position.set(lx, 2.15, 1.1);
            group.add(cap);
        }

        // 脇に置かれた編み籠（ナツメヤシの実などの大容器）
        for (const bx of [-2.7, 2.7]) {
            const basket = new THREE.Mesh(
                new THREE.CylinderGeometry(0.38, 0.32, 0.5, 10),
                new THREE.MeshStandardMaterial({ color: 0x6A4822, roughness: 0.95 })
            );
            basket.position.set(bx, 0.25, 1.3);
            group.add(basket);
            for (let f = 0; f < 6; f++) {
                const d2 = new THREE.Mesh(
                    new THREE.SphereGeometry(0.08, 5, 4),
                    new THREE.MeshStandardMaterial({
                        color: bx < 0 ? 0x5A2E12 : 0xB83A18,
                        roughness: 0.8,
                    })
                );
                d2.position.set(
                    bx + (Math.random() - 0.5) * 0.4,
                    0.55 + (Math.random() - 0.5) * 0.05,
                    1.3 + (Math.random() - 0.5) * 0.4
                );
                group.add(d2);
            }
        }

        // バザール正面の小さな書法看板
        const sign = this._buildCalligraphyBanner(2.0, 0.4, 3.7, 0.2);
        group.add(sign);
    }

    /* --- 大モスク（中央オニオンドーム＋4隅ミナレット） --- */
    _buildGrandMosque(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xE8C896, roughness: 0.92,
        });
        const wallMatDk = new THREE.MeshStandardMaterial({
            color: 0xB89366, roughness: 0.92,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A4A2A, roughness: 0.85,
        });
        const domeColor = 0x8C3B1C;

        const w = 8.5, h = 3.8, d = 4.5;

        // 基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(w + 1.0, 0.35, d + 0.6), trimMat
        );
        base.position.y = 0.17;
        group.add(base);

        // 本体
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
        body.position.y = 0.35 + h / 2;
        group.add(body);

        // 装飾帯（青タイル）
        const blueBand = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.05, 0.4, d + 0.05),
            new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
        );
        blueBand.position.y = 0.35 + h * 0.85;
        group.add(blueBand);

        // コーニス上段
        const cornice = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.5, 0.25, d + 0.4), trimMat
        );
        cornice.position.y = 0.35 + h + 0.12;
        group.add(cornice);

        // 胸壁
        for (let cx = -w / 2 + 0.4; cx < w / 2; cx += 0.7) {
            const merlon = new THREE.Mesh(
                new THREE.BoxGeometry(0.35, 0.35, 0.35), wallMatDk
            );
            merlon.position.set(cx, 0.35 + h + 0.42, d / 2 + 0.15);
            group.add(merlon);
        }

        // 中央の大きな尖頭アーチ入り口（イワン）
        const iwan = this._buildPointedArch(2.2, 3.2, 0.2, 0x1A0F08);
        iwan.position.set(0, 0.35, d / 2 + 0.02);
        group.add(iwan);

        // イワンの枠
        const iwanFrameV = new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.85 });
        for (const sx of [-1.25, 1.25]) {
            const fv = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.2, 0.18), iwanFrameV);
            fv.position.set(sx, 0.35 + 1.6, d / 2 + 0.12);
            group.add(fv);
        }

        // 中央大ドームのドラム
        const mainDrum = new THREE.Mesh(
            new THREE.CylinderGeometry(1.6, 1.75, 1.0, 16), trimMat
        );
        mainDrum.position.y = 0.35 + h + 0.8;
        group.add(mainDrum);
        // ドラムの尖頭アーチ窓
        for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 6) {
            const slit = new THREE.Mesh(
                new THREE.BoxGeometry(0.2, 0.55, 0.08),
                new THREE.MeshStandardMaterial({ color: 0x1A1208 })
            );
            slit.position.set(
                Math.cos(ang) * 1.76, 0.35 + h + 0.8, Math.sin(ang) * 1.76
            );
            slit.rotation.y = -ang + Math.PI / 2;
            group.add(slit);
        }

        // 中央大オニオンドーム
        const mainDome = this._buildOnionDome(1.9, 4.8, domeColor, 20);
        mainDome.position.y = 0.35 + h + 1.3;
        group.add(mainDome);
        // リブ
        for (let r = 0; r < 12; r++) {
            const ang = (r / 12) * Math.PI * 2;
            const rib = new THREE.Mesh(
                new THREE.BoxGeometry(0.05, 4.3, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x4E2010, roughness: 0.85 })
            );
            rib.position.set(Math.cos(ang) * 1.6, 0.35 + h + 3.2, Math.sin(ang) * 1.6);
            rib.rotation.z = 0.06 * Math.cos(ang);
            rib.rotation.x = 0.06 * Math.sin(ang);
            group.add(rib);
        }
        group.add(this._buildDomeFinial(0.35 + h + 6.1));

        // 脇の小ドーム（2つ）
        for (const sx of [-3.2, 3.2]) {
            const sDrum = new THREE.Mesh(
                new THREE.CylinderGeometry(0.75, 0.85, 0.5, 12), trimMat
            );
            sDrum.position.set(sx, 0.35 + h + 0.4, 0);
            group.add(sDrum);
            const sDome = this._buildOnionDome(0.9, 2.3, domeColor, 14);
            sDome.position.set(sx, 0.35 + h + 0.65, 0);
            group.add(sDome);
            for (let r = 0; r < 8; r++) {
                const ang = (r / 8) * Math.PI * 2;
                const rib = new THREE.Mesh(
                    new THREE.BoxGeometry(0.03, 2.1, 0.03),
                    new THREE.MeshStandardMaterial({ color: 0x4E2010 })
                );
                rib.position.set(sx + Math.cos(ang) * 0.78, 0.35 + h + 1.55, Math.sin(ang) * 0.78);
                group.add(rib);
            }
            group.add(this._buildDomeFinial(0.35 + h + 2.95, sx));
        }

        // 4隅のミナレット
        for (const mx of [-w / 2 - 0.4, w / 2 + 0.4]) {
            // 基段
            const mBase = new THREE.Mesh(
                new THREE.BoxGeometry(0.9, 0.8, 0.9), trimMat
            );
            mBase.position.set(mx, 0.4, 0);
            group.add(mBase);
            // 本体（8角）
            const shaft = new THREE.Mesh(
                new THREE.CylinderGeometry(0.4, 0.48, 6.0, 8), wallMat
            );
            shaft.position.set(mx, 3.8, 0);
            group.add(shaft);
            // 青タイル帯
            const mBand = new THREE.Mesh(
                new THREE.CylinderGeometry(0.43, 0.43, 0.25, 8),
                new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
            );
            mBand.position.set(mx, 2.8, 0);
            group.add(mBand);
            // バルコニー
            const balcony = new THREE.Mesh(
                new THREE.CylinderGeometry(0.68, 0.68, 0.22, 8), trimMat
            );
            balcony.position.set(mx, 6.9, 0);
            group.add(balcony);
            // バルコニー手すり
            for (let bi = 0; bi < 8; bi++) {
                const ang = (bi / 8) * Math.PI * 2;
                const bal = new THREE.Mesh(
                    new THREE.BoxGeometry(0.04, 0.28, 0.04),
                    new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
                );
                bal.position.set(mx + Math.cos(ang) * 0.65, 7.15, Math.sin(ang) * 0.65);
                group.add(bal);
            }
            // 上部シャフト
            const shaftU = new THREE.Mesh(
                new THREE.CylinderGeometry(0.32, 0.38, 1.3, 8), wallMatDk
            );
            shaftU.position.set(mx, 7.75, 0);
            group.add(shaftU);
            // オニオン頭
            const mDome = this._buildOnionDome(0.5, 1.6, domeColor, 12);
            mDome.position.set(mx, 8.4, 0);
            group.add(mDome);
            group.add(this._buildDomeFinial(9.95, mx));
        }

        // 前面のアーチ連（ファサードの装飾）
        for (const ax of [-3.3, -2.0, 2.0, 3.3]) {
            const arch = this._buildPointedArch(0.7, 1.2, 0.08, 0x5A3A1A);
            arch.position.set(ax, 0.35 + 1.0, d / 2 + 0.03);
            group.add(arch);
            // 内側の暗い開口
            const inner = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.8, 0.05),
                new THREE.MeshStandardMaterial({ color: 0x1E1008 })
            );
            inner.position.set(ax, 0.35 + 1.1, d / 2 + 0.08);
            group.add(inner);
        }

        // 入り口上の大きな書法バナー
        const mBanner = this._buildCalligraphyBanner(2.6, 0.55, 0.35 + 3.55, d / 2 + 0.1);
        group.add(mBanner);
    }

    /* --- アラビア風の門（装飾アーチ＋旗） --- */
    _buildArabianGate(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xCFA870, roughness: 0.92,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A4A2A, roughness: 0.85,
        });

        // 左右の塔
        for (const sx of [-2.4, 2.4]) {
            const tw = new THREE.Mesh(
                new THREE.BoxGeometry(1.6, 5.5, 1.6), wallMat
            );
            tw.position.set(sx, 2.75, 0);
            group.add(tw);
            // 胸壁
            for (let cx = -0.6; cx <= 0.6; cx += 0.6) {
                for (let cz of [-0.6, 0.6]) {
                    const m = new THREE.Mesh(
                        new THREE.BoxGeometry(0.35, 0.5, 0.35), trimMat
                    );
                    m.position.set(sx + cx, 5.75, cz);
                    group.add(m);
                }
            }
            // 塔の窓スリット
            for (let y = 1.8; y < 5; y += 1.0) {
                const slit = new THREE.Mesh(
                    new THREE.BoxGeometry(0.3, 0.6, 0.08),
                    new THREE.MeshStandardMaterial({ color: 0x1A0F08 })
                );
                slit.position.set(sx, y, 0.82);
                group.add(slit);
            }
            // 小オニオン頭
            const dome = this._buildOnionDome(0.55, 1.7, 0x8C3B1C, 14);
            dome.position.set(sx, 5.9, 0);
            group.add(dome);
            group.add(this._buildDomeFinial(7.6, sx));
        }

        // 中央の連結部（アーチの上の壁）
        const arch = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 2.2, 1.2), wallMat
        );
        arch.position.set(0, 4.9, 0);
        group.add(arch);
        // アーチ開口（尖頭）
        const archOpen = this._buildPointedArch(2.4, 3.8, 1.3, 0x1A0F08);
        archOpen.position.set(0, 0, 0);
        group.add(archOpen);

        // 中央上の書法バナー
        const banner = this._buildCalligraphyBanner(3.2, 0.7, 5.2, 0.62);
        group.add(banner);

        // 旗（三角ペナント、左右塔頂に1本ずつ）
        const flagMat = new THREE.MeshStandardMaterial({
            color: 0x2E7A8A, roughness: 0.8, side: THREE.DoubleSide,
        });
        for (const sx of [-2.4, 2.4]) {
            const pole = new THREE.Mesh(
                new THREE.CylinderGeometry(0.04, 0.04, 1.8, 4),
                new THREE.MeshStandardMaterial({ color: 0x3A2A1A })
            );
            pole.position.set(sx, 8.5, 0);
            group.add(pole);
            const flagShape = new THREE.Shape();
            flagShape.moveTo(0, 0);
            flagShape.lineTo(1.0, -0.15);
            flagShape.lineTo(0, -0.5);
            const flagGeo = new THREE.ShapeGeometry(flagShape);
            const flag = new THREE.Mesh(flagGeo, flagMat);
            flag.position.set(sx + 0.04, 9.3, 0);
            group.add(flag);
        }

        // 装飾タイル帯
        const tileBand = new THREE.Mesh(
            new THREE.BoxGeometry(3.6, 0.25, 1.22),
            new THREE.MeshStandardMaterial({ color: 0x2B4E7A, roughness: 0.5 })
        );
        tileBand.position.set(0, 4.2, 0);
        group.add(tileBand);
    }

    _buildStoneBuilding(group) {
        // Metal Slug風の石造りヨーロッパ建物
        const w = 4 + Math.random() * 3;
        const h = 5 + Math.random() * 4;
        const stoneColor = [0x9B8B7B, 0x8B7B6B, 0xA09080][Math.floor(Math.random() * 3)];

        // 本体
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 3),
            new THREE.MeshStandardMaterial({ color: stoneColor, roughness: 0.9 })
        );
        body.position.y = h / 2;
        group.add(body);

        // 瓦屋根
        const roofShape = new THREE.Shape();
        roofShape.moveTo(-w / 2 - 0.5, 0);
        roofShape.lineTo(0, 2.0);
        roofShape.lineTo(w / 2 + 0.5, 0);
        const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 3.5, bevelEnabled: false });
        const roofColors = [0x8B3A1A, 0x7B4A2A, 0x6B3A1A];
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: roofColors[Math.floor(Math.random() * roofColors.length)],
            roughness: 0.85,
        }));
        roof.position.set(0, h, -1.75);
        group.add(roof);

        // 窓（アーチ型風）
        const winMat = new THREE.MeshStandardMaterial({ color: 0x1A1A2A, roughness: 0.3 });
        const frameMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.7 });
        for (let wy = 2; wy < h - 1; wy += 2.5) {
            for (let wx = -w / 3; wx <= w / 3; wx += w / 2.5) {
                if (Math.random() > 0.2) {
                    // 窓枠
                    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.15), frameMat);
                    frame.position.set(wx, wy, 1.55);
                    group.add(frame);
                    // 窓ガラス（暗い）
                    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.65, 1.0, 0.1), winMat);
                    glass.position.set(wx, wy, 1.6);
                    group.add(glass);
                }
            }
        }

        // ドア
        const door = new THREE.Mesh(
            new THREE.BoxGeometry(1.0, 1.8, 0.15),
            new THREE.MeshStandardMaterial({ color: 0x4A3A2A, roughness: 0.8 })
        );
        door.position.set(0, 0.9, 1.55);
        group.add(door);
    }

    _buildWatchTower(group) {
        // 監視塔（Metal Slug定番）
        const towerMat = new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.85, metalness: 0.1,
        });
        // 塔本体
        const tower = new THREE.Mesh(new THREE.BoxGeometry(2.5, 10, 2.5), towerMat);
        tower.position.y = 5;
        group.add(tower);

        // 見張り台
        const platform = new THREE.Mesh(
            new THREE.BoxGeometry(3.5, 0.3, 3.5),
            new THREE.MeshStandardMaterial({ color: 0x6B5B4B, roughness: 0.8 })
        );
        platform.position.y = 10.2;
        group.add(platform);

        // 手すり
        const railMat = new THREE.MeshStandardMaterial({ color: 0x5A5A5A, metalness: 0.3 });
        for (let side of [-1.7, 1.7]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.0, 3.5), railMat);
            rail.position.set(side, 10.8, 0);
            group.add(rail);
            const rail2 = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.06, 1.0), railMat);
            rail2.position.set(0, 10.8, side);
            group.add(rail2);
        }

        // 窓スリット
        const slitMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let y = 3; y <= 8; y += 2.5) {
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.3), slitMat);
            slit.position.set(0, y, 1.3);
            group.add(slit);
        }

        // サーチライト
        const lightGeo = new THREE.CylinderGeometry(0.15, 0.25, 0.5, 8);
        const light = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({
            color: 0xAAAA55, roughness: 0.3, metalness: 0.5,
        }));
        light.position.set(1.8, 10.5, 0);
        light.rotation.z = Math.PI / 4;
        group.add(light);
    }

    _buildSteelFrame(group) {
        // 鉄骨構造物（建設中/破壊された）
        const steelMat = new THREE.MeshStandardMaterial({
            color: 0x6A5A4A, roughness: 0.5, metalness: 0.5,
        });
        const h = 6 + Math.random() * 5;

        // 柱
        for (let x of [-2, 2]) {
            for (let z of [-1, 1]) {
                const col = new THREE.Mesh(
                    new THREE.BoxGeometry(0.2, h, 0.2),
                    steelMat
                );
                col.position.set(x, h / 2, z);
                group.add(col);
            }
        }

        // 横梁
        for (let y = 2; y <= h; y += 2.5) {
            const beam1 = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.15, 0.15), steelMat);
            beam1.position.set(0, y, -1);
            group.add(beam1);
            const beam2 = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.15, 0.15), steelMat);
            beam2.position.set(0, y, 1);
            group.add(beam2);
            // 斜め筋交い
            if (Math.random() > 0.4) {
                const brace = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.5, 0.08), steelMat);
                brace.position.set(Math.random() > 0.5 ? -2 : 2, y, 0);
                brace.rotation.z = 0.6 * (Math.random() > 0.5 ? 1 : -1);
                group.add(brace);
            }
        }

        // 階段
        const stairMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, metalness: 0.4 });
        for (let s = 0; s < 5; s++) {
            const step = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.08, 0.4), stairMat);
            step.position.set(-2.5 + s * 0.5, 0.5 + s * 0.5, 0);
            step.rotation.z = -0.15;
            group.add(step);
        }
    }

    _buildWarehouse(group) {
        const w = 6 + Math.random() * 3;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, 3.5, 4),
            new THREE.MeshStandardMaterial({ color: 0x6B7B6B, roughness: 0.8 })
        );
        body.position.y = 1.75;
        group.add(body);

        // 波板屋根
        const roofGeo = new THREE.CylinderGeometry(w / 2 + 0.3, w / 2 + 0.3, 4.5, 8, 1, false, 0, Math.PI);
        const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({
            color: 0x7B7B7B, roughness: 0.6, metalness: 0.3,
        }));
        roof.position.set(0, 3.5, 0);
        roof.rotation.z = Math.PI / 2;
        group.add(roof);

        // シャッター
        const shutter = new THREE.Mesh(
            new THREE.BoxGeometry(2.5, 2.8, 0.1),
            new THREE.MeshStandardMaterial({ color: 0x5A5A5A, roughness: 0.5, metalness: 0.4 })
        );
        shutter.position.set(0, 1.4, 2.05);
        group.add(shutter);
    }

    _buildFortWall(group) {
        // 石壁の要塞
        const wallLen = 8 + Math.random() * 6;
        const wallH = 3 + Math.random() * 2;
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0x8B7B6B, roughness: 0.95,
        });
        const wall = new THREE.Mesh(new THREE.BoxGeometry(wallLen, wallH, 1.5), wallMat);
        wall.position.y = wallH / 2;
        group.add(wall);

        // 胸壁（凹凸のある上部）
        for (let x = -wallLen / 2 + 0.5; x < wallLen / 2; x += 1.5) {
            if (Math.random() > 0.3) {
                const merlon = new THREE.Mesh(
                    new THREE.BoxGeometry(0.8, 0.8, 1.6),
                    wallMat
                );
                merlon.position.set(x, wallH + 0.4, 0);
                group.add(merlon);
            }
        }

        // 銃眼
        const slitMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let x = -wallLen / 3; x <= wallLen / 3; x += wallLen / 3) {
            const slit = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), slitMat);
            slit.position.set(x, wallH * 0.6, 0.8);
            group.add(slit);
        }
    }

    /* --- 砂漠の遺跡（崩れた柱と石壁） --- */
    _buildDesertRuins(group) {
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xC9A876, roughness: 0.95, metalness: 0.0, flatShading: true,
        });
        const stoneMatDk = new THREE.MeshStandardMaterial({
            color: 0xA0845A, roughness: 0.95, flatShading: true,
        });

        // 崩れた石の基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(7, 0.6, 3),
            stoneMatDk
        );
        base.position.y = 0.3;
        group.add(base);

        // 複数の柱（一部は折れている）
        const columnCount = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < columnCount; i++) {
            const isBroken = Math.random() > 0.5;
            const h = isBroken ? (1 + Math.random() * 2) : (4 + Math.random() * 2);
            // 柱本体（溝付きの円柱）
            const col = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.4, h, 10),
                stoneMat
            );
            col.position.set(-3 + i * 1.5, h / 2 + 0.6, 0);
            group.add(col);

            // 柱頭
            if (!isBroken) {
                const cap = new THREE.Mesh(
                    new THREE.BoxGeometry(0.9, 0.2, 0.9),
                    stoneMatDk
                );
                cap.position.set(col.position.x, h + 0.7, 0);
                group.add(cap);
                // 上部装飾
                const capTop = new THREE.Mesh(
                    new THREE.BoxGeometry(0.75, 0.15, 0.75),
                    stoneMat
                );
                capTop.position.set(col.position.x, h + 0.85, 0);
                group.add(capTop);
            } else {
                // 折れた断面（斜め）
                const broken = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.38, 0.32, 0.1, 10),
                    stoneMatDk
                );
                broken.position.set(col.position.x, h + 0.65, 0);
                broken.rotation.z = (Math.random() - 0.5) * 0.3;
                group.add(broken);
            }
        }

        // 倒れた柱の破片
        for (let i = 0; i < 2; i++) {
            const piece = new THREE.Mesh(
                new THREE.CylinderGeometry(0.3, 0.35, 1.2 + Math.random(), 8),
                stoneMat
            );
            piece.position.set(-2 + i * 2.5, 0.3, 1.8);
            piece.rotation.z = Math.PI / 2;
            piece.rotation.y = (Math.random() - 0.5) * 0.5;
            group.add(piece);
        }
    }

    /* --- オベリスク（エジプト風の尖塔） --- */
    _buildObelisk(group) {
        const stoneMat = new THREE.MeshStandardMaterial({
            color: 0xBEA56E, roughness: 0.9, flatShading: true,
        });
        const stoneMatDk = new THREE.MeshStandardMaterial({
            color: 0x8E7543, roughness: 0.9, flatShading: true,
        });

        // 基壇（3段）
        for (let tier = 0; tier < 3; tier++) {
            const size = 3.2 - tier * 0.5;
            const ht = 0.4;
            const step = new THREE.Mesh(
                new THREE.BoxGeometry(size, ht, size),
                tier % 2 === 0 ? stoneMat : stoneMatDk
            );
            step.position.y = tier * ht + ht / 2;
            group.add(step);
        }

        // メインのオベリスク本体
        const obeliskHeight = 9 + Math.random() * 3;
        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(0.4, 0.65, obeliskHeight, 4),
            stoneMat
        );
        shaft.position.y = 1.2 + obeliskHeight / 2;
        shaft.rotation.y = Math.PI / 4;
        group.add(shaft);

        // 頂上ピラミッド
        const tip = new THREE.Mesh(
            new THREE.ConeGeometry(0.5, 1.0, 4),
            stoneMatDk
        );
        tip.position.y = 1.2 + obeliskHeight + 0.5;
        tip.rotation.y = Math.PI / 4;
        group.add(tip);

        // 風化の亀裂（側面の暗い帯）
        for (let k = 0; k < 2; k++) {
            const crack = new THREE.Mesh(
                new THREE.BoxGeometry(0.03, obeliskHeight * 0.6, 0.03),
                new THREE.MeshBasicMaterial({ color: 0x5a4520 })
            );
            crack.position.set(0.42, 2 + k * 2, 0);
            group.add(crack);
        }
    }

    /* --- 砂漠の寺院（アラブ風のドーム建造物） --- */
    _buildDesertTemple(group) {
        const wallMat = new THREE.MeshStandardMaterial({
            color: 0xD6B88C, roughness: 0.9,
        });
        const domeMat = new THREE.MeshStandardMaterial({
            color: 0x9E8560, roughness: 0.7, metalness: 0.1,
        });
        const trimMat = new THREE.MeshStandardMaterial({
            color: 0x7A5F3A, roughness: 0.8,
        });

        // 基壇
        const base = new THREE.Mesh(
            new THREE.BoxGeometry(6, 0.5, 4),
            trimMat
        );
        base.position.y = 0.25;
        group.add(base);

        // 本体
        const w = 5;
        const h = 3.5;
        const body = new THREE.Mesh(
            new THREE.BoxGeometry(w, h, 3.5),
            wallMat
        );
        body.position.y = 0.5 + h / 2;
        group.add(body);

        // 中央のアーチ入り口（暗い長方形）
        const arch = new THREE.Mesh(
            new THREE.BoxGeometry(1.0, 1.8, 0.1),
            new THREE.MeshStandardMaterial({ color: 0x2B1A0F, roughness: 0.4 })
        );
        arch.position.set(0, 1.4, 1.76);
        group.add(arch);
        // アーチ上部（曲線を模倣）
        const archTop = new THREE.Mesh(
            new THREE.SphereGeometry(0.5, 8, 6, 0, Math.PI),
            new THREE.MeshStandardMaterial({ color: 0x2B1A0F, roughness: 0.4 })
        );
        archTop.rotation.x = -Math.PI / 2;
        archTop.rotation.y = Math.PI;
        archTop.position.set(0, 2.3, 1.76);
        archTop.scale.set(1, 1, 0.3);
        group.add(archTop);

        // サイドウィンドウ（小さい暗窓）
        for (let sx of [-1.6, 1.6]) {
            const win = new THREE.Mesh(
                new THREE.BoxGeometry(0.5, 0.8, 0.1),
                new THREE.MeshStandardMaterial({ color: 0x1A1020 })
            );
            win.position.set(sx, 2.4, 1.76);
            group.add(win);
        }

        // 屋根のトリム
        const trim = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.3, 0.3, 3.8),
            trimMat
        );
        trim.position.y = 0.5 + h + 0.15;
        group.add(trim);

        // メインドーム
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(1.8, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2),
            domeMat
        );
        dome.position.y = 0.5 + h + 0.3;
        group.add(dome);

        // ドーム頂上の月柱（三日月の簡易表現）
        const spire = new THREE.Mesh(
            new THREE.CylinderGeometry(0.04, 0.05, 0.8, 6),
            new THREE.MeshStandardMaterial({ color: 0xDAA850, metalness: 0.6, roughness: 0.3 })
        );
        spire.position.y = 0.5 + h + 2.1;
        group.add(spire);

        // 両脇のミナレット（小塔）
        for (let mx of [-2.4, 2.4]) {
            const tower = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.4, 5, 8),
                wallMat
            );
            tower.position.set(mx, 2.5, 0);
            group.add(tower);

            const towerDome = new THREE.Mesh(
                new THREE.SphereGeometry(0.45, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
                domeMat
            );
            towerDome.position.set(mx, 5.0, 0);
            group.add(towerDome);
        }
    }

    /* --- Layer 4: 近景の鉄骨・電柱・看板 --- */
    _buildForegroundStructures(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -3; i <= 7; i++) {
            const pGroup = new THREE.Group();
            const type = Math.floor(Math.random() * 7);

            if (type === 0) {
                this._buildPalmTree(pGroup);
            } else if (type === 1) {
                this._buildPowerPole(pGroup);
            } else if (type === 2) {
                this._buildMilitarySign(pGroup);
            } else if (type === 3) {
                this._buildWreckage(pGroup);
            } else if (type === 4) {
                this._buildStreetLamp(pGroup);
            } else if (type === 5) {
                this._buildMarketCanopy(pGroup);
            } else {
                this._buildRuinedStatue(pGroup);
            }

            pGroup.position.set(
                i * 18 + (Math.random() - 0.5) * 8,
                0,
                zPos + (Math.random() - 0.5) * 3
            );
            this.scene.add(pGroup);
            layer.objects.push(pGroup);
        }
        this.bgLayers.push(layer);
    }

    _buildPalmTree(group) {
        // 幹（曲がった）
        const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8B6914, roughness: 0.9 });
        const segments = 4;
        let prevY = 0;
        let prevX = 0;
        const lean = (Math.random() - 0.5) * 0.4;
        for (let s = 0; s < segments; s++) {
            const segH = 1.5 + Math.random() * 0.5;
            const topR = 0.12 - s * 0.02;
            const botR = 0.2 - s * 0.02;
            const seg = new THREE.Mesh(
                new THREE.CylinderGeometry(Math.max(topR, 0.06), Math.max(botR, 0.08), segH, 6),
                trunkMat
            );
            seg.position.set(prevX + lean * s * 0.3, prevY + segH / 2, 0);
            seg.rotation.z = lean * s * 0.15;
            group.add(seg);
            prevY += segH;
            prevX += lean * 0.3;
        }

        // 葉
        const leafMat = new THREE.MeshStandardMaterial({
            color: 0x2D5A1E, roughness: 0.8, side: THREE.DoubleSide,
        });
        for (let i = 0; i < 7; i++) {
            const leafGeo = new THREE.PlaneGeometry(0.7, 2.8);
            const leaf = new THREE.Mesh(leafGeo, leafMat);
            const angle = (i / 7) * Math.PI * 2;
            leaf.position.set(
                prevX + Math.cos(angle) * 0.4,
                prevY + 0.5 + Math.random() * 0.3,
                Math.sin(angle) * 0.4
            );
            leaf.rotation.set(0.7 + Math.random() * 0.3, angle, 0);
            group.add(leaf);
        }

        // 実のバリエーション： ココナッツ / ナツメヤシ（濃茶） / オレンジの房
        const fruitVariant = Math.random();
        if (fruitVariant > 0.3) {
            if (fruitVariant > 0.7) {
                // オレンジの房（コンセプト画像風）
                for (let c = 0; c < 2; c++) {
                    const ca = (c / 2) * Math.PI * 2 + Math.random() * 0.5;
                    for (let f = 0; f < 7; f++) {
                        const orange = new THREE.Mesh(
                            new THREE.SphereGeometry(0.09, 5, 4),
                            new THREE.MeshStandardMaterial({
                                color: 0xE87838, roughness: 0.75,
                                emissive: 0x3a1a08, emissiveIntensity: 0.12,
                            })
                        );
                        orange.position.set(
                            prevX + Math.cos(ca) * 0.3 + (Math.random() - 0.5) * 0.15,
                            prevY - 0.15 - Math.random() * 0.35,
                            Math.sin(ca) * 0.3 + (Math.random() - 0.5) * 0.15
                        );
                        group.add(orange);
                    }
                }
            } else if (fruitVariant > 0.5) {
                // ナツメヤシの房（小さな濃茶の実がびっしり）
                for (let c = 0; c < 3; c++) {
                    const ca = (c / 3) * Math.PI * 2 + Math.random() * 0.3;
                    for (let f = 0; f < 10; f++) {
                        const date = new THREE.Mesh(
                            new THREE.SphereGeometry(0.05, 4, 3),
                            new THREE.MeshStandardMaterial({ color: 0x5A2E12, roughness: 0.85 })
                        );
                        date.position.set(
                            prevX + Math.cos(ca) * 0.25 + (Math.random() - 0.5) * 0.12,
                            prevY - 0.1 - Math.random() * 0.4,
                            Math.sin(ca) * 0.25 + (Math.random() - 0.5) * 0.12
                        );
                        group.add(date);
                    }
                }
            } else {
                // ココナッツ（デフォルト）
                for (let c = 0; c < 3; c++) {
                    const coconut = new THREE.Mesh(
                        new THREE.SphereGeometry(0.12, 6, 4),
                        new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.9 })
                    );
                    coconut.position.set(
                        prevX + (Math.random() - 0.5) * 0.3,
                        prevY - 0.2,
                        (Math.random() - 0.5) * 0.3
                    );
                    group.add(coconut);
                }
            }
        }
    }

    _buildPowerPole(group) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.8 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 9, 6), poleMat);
        pole.position.y = 4.5;
        group.add(pole);

        // 横木（2段）
        for (let y of [7.5, 8.5]) {
            const cross = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 0.1), poleMat);
            cross.position.y = y;
            group.add(cross);
        }

        // 碍子
        const insulatorMat = new THREE.MeshStandardMaterial({ color: 0xAABBAA, roughness: 0.4 });
        for (let y of [7.5, 8.5]) {
            for (let x of [-1.3, -0.4, 0.4, 1.3]) {
                const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.15, 6), insulatorMat);
                ins.position.set(x, y + 0.1, 0);
                group.add(ins);
            }
        }
    }

    _buildMilitarySign(group) {
        // 軍事看板
        const postMat = new THREE.MeshStandardMaterial({ color: 0x5A5A5A, metalness: 0.3 });
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3, 6), postMat);
        post.position.y = 1.5;
        group.add(post);

        // 看板本体
        const signColors = [0x4A6B4A, 0x6B4A2A, 0x8B2020];
        const signColor = signColors[Math.floor(Math.random() * signColors.length)];
        const sign = new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 1.0, 0.08),
            new THREE.MeshStandardMaterial({ color: signColor, roughness: 0.7 })
        );
        sign.position.y = 3.2;
        group.add(sign);

        // 矢印マーク
        const arrowMat = new THREE.MeshStandardMaterial({ color: 0xDDDD88 });
        const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.1), arrowMat);
        arrow.position.set(0, 3.2, 0.05);
        group.add(arrow);
        const arrowHead = new THREE.Mesh(
            new THREE.ConeGeometry(0.2, 0.4, 3),
            arrowMat
        );
        arrowHead.position.set(0.6, 3.2, 0.05);
        arrowHead.rotation.z = -Math.PI / 2;
        group.add(arrowHead);
    }

    _buildWreckage(group) {
        const bodyGeo = new THREE.BoxGeometry(3.5, 1.3, 1.8);
        const body = new THREE.Mesh(bodyGeo, new THREE.MeshStandardMaterial({
            color: 0x5A5A4A, roughness: 0.9, metalness: 0.1,
        }));
        body.position.y = 0.65;
        body.rotation.z = (Math.random() - 0.5) * 0.3;
        body.rotation.y = (Math.random() - 0.5) * 0.2;
        group.add(body);

        // タイヤ
        const tireMat = new THREE.MeshStandardMaterial({ color: 0x1A1A1A });
        for (let x of [-1.2, 1.2]) {
            const tire = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.14, 6, 8), tireMat);
            tire.position.set(x, 0.35, 1);
            tire.rotation.y = Math.PI / 2;
            group.add(tire);
        }

        // 焼け焦げ跡
        const scorch = new THREE.Mesh(
            new THREE.CircleGeometry(1.5, 8),
            new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 1.0 })
        );
        scorch.rotation.x = -Math.PI / 2;
        scorch.position.y = 0.02;
        group.add(scorch);
    }

    _buildStreetLamp(group) {
        const poleMat = new THREE.MeshStandardMaterial({ color: 0x4A4A4A, metalness: 0.4 });
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 5, 6), poleMat);
        pole.position.y = 2.5;
        group.add(pole);

        // 曲がったアーム
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 0.06), poleMat);
        arm.position.set(0.5, 5.0, 0);
        arm.rotation.z = -0.2;
        group.add(arm);

        // ランプ（壊れている）
        const lamp = new THREE.Mesh(
            new THREE.ConeGeometry(0.25, 0.4, 6),
            new THREE.MeshStandardMaterial({ color: 0x888866, roughness: 0.5 })
        );
        lamp.position.set(1.1, 4.8, 0);
        lamp.rotation.z = Math.PI;
        group.add(lamp);
    }

    _buildMarketCanopy(group) {
        const postMat = new THREE.MeshStandardMaterial({ color: 0x6A4A2A, roughness: 0.88 });
        const clothA = new THREE.MeshStandardMaterial({ color: 0xD84A2A, roughness: 0.92, side: THREE.DoubleSide });
        const clothB = new THREE.MeshStandardMaterial({ color: 0xE7CF8A, roughness: 0.92, side: THREE.DoubleSide });

        for (const x of [-1.15, 1.15]) {
            for (const z of [-0.75, 0.75]) {
                const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.2, 6), postMat);
                post.position.set(x, 1.1, z);
                group.add(post);
            }
        }

        for (let i = 0; i < 6; i++) {
            const cloth = new THREE.Mesh(
                new THREE.BoxGeometry(2.4, 0.06, 0.28),
                i % 2 === 0 ? clothA : clothB
            );
            cloth.position.set(0, 2.28 - i * 0.05, -0.7 + i * 0.28);
            group.add(cloth);
        }

        const table = new THREE.Mesh(
            new THREE.BoxGeometry(2.0, 0.1, 1.0),
            new THREE.MeshStandardMaterial({ color: 0x8A6338, roughness: 0.86 })
        );
        table.position.y = 0.85;
        group.add(table);

        const basketMat = new THREE.MeshStandardMaterial({ color: 0x7A4A28, roughness: 0.9 });
        for (const x of [-0.65, 0, 0.65]) {
            const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.2, 8), basketMat);
            basket.position.set(x, 0.98, 0);
            group.add(basket);
            for (let f = 0; f < 6; f++) {
                const fruit = new THREE.Mesh(
                    new THREE.SphereGeometry(0.07, 5, 4),
                    new THREE.MeshStandardMaterial({
                        color: f % 2 === 0 ? 0xE67A2E : 0xD2B04A,
                        roughness: 0.75,
                        emissive: 0x2A1408,
                        emissiveIntensity: 0.1,
                    })
                );
                fruit.position.set(
                    x + (Math.random() - 0.5) * 0.22,
                    1.08 + Math.random() * 0.06,
                    (Math.random() - 0.5) * 0.18
                );
                group.add(fruit);
            }
        }
    }

    _buildRuinedStatue(group) {
        const stone = new THREE.MeshStandardMaterial({ color: 0xB79A72, roughness: 0.95, flatShading: true });
        const stoneDark = new THREE.MeshStandardMaterial({ color: 0x8E7455, roughness: 0.95, flatShading: true });

        const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.45, 1.6), stoneDark);
        base.position.y = 0.225;
        group.add(base);

        const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.48, 1.4, 7), stone);
        torso.position.set(0, 1.2, 0);
        torso.rotation.z = (Math.random() - 0.5) * 0.18;
        group.add(torso);

        const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34, 0), stone);
        head.position.set(0.05, 2.1, 0);
        group.add(head);

        const brokenArm = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.18, 0.22), stoneDark);
        brokenArm.position.set(0.4, 1.55, 0.18);
        brokenArm.rotation.z = -0.65;
        group.add(brokenArm);

        for (let i = 0; i < 7; i++) {
            const rubble = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.12 + Math.random() * 0.2, 0),
                Math.random() > 0.5 ? stone : stoneDark
            );
            rubble.position.set(
                (Math.random() - 0.5) * 2.4,
                0.08 + Math.random() * 0.18,
                (Math.random() - 0.5) * 1.4
            );
            rubble.rotation.set(Math.random(), Math.random(), Math.random());
            group.add(rubble);
        }
    }

    /* --- Layer 5: 最前景の瓦礫 --- */
    _buildNearForeground(zPos, parallaxRate) {
        const layer = { objects: [], parallaxRate, zPos };
        for (let i = -2; i <= 6; i++) {
            if (Math.random() > 0.4) {
                const dGroup = new THREE.Group();
                this._buildDebrisPile(dGroup);
                dGroup.position.set(
                    i * 20 + (Math.random() - 0.5) * 10,
                    0,
                    zPos + (Math.random() - 0.5) * 2
                );
                this.scene.add(dGroup);
                layer.objects.push(dGroup);
            }
        }
        this.bgLayers.push(layer);
    }

    _buildDebrisPile(group) {
        const debrisMat = new THREE.MeshStandardMaterial({
            color: 0x7B6B5B, roughness: 0.95,
        });
        const count = 3 + Math.floor(Math.random() * 5);
        for (let i = 0; i < count; i++) {
            const size = 0.3 + Math.random() * 0.8;
            const geo = Math.random() > 0.5
                ? new THREE.BoxGeometry(size, size * 0.6, size * 0.8)
                : new THREE.DodecahedronGeometry(size * 0.4, 0);
            const piece = new THREE.Mesh(geo, debrisMat);
            piece.position.set(
                (Math.random() - 0.5) * 3,
                size * 0.3,
                (Math.random() - 0.5) * 1.5
            );
            piece.rotation.set(
                Math.random() * 0.5,
                Math.random() * Math.PI,
                Math.random() * 0.5
            );
            group.add(piece);
        }

        // 鉄筋
        if (Math.random() > 0.5) {
            const rebarMat = new THREE.MeshStandardMaterial({
                color: 0x8B5A2B, roughness: 0.6, metalness: 0.4,
            });
            for (let r = 0; r < 2; r++) {
                const rebar = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.02, 0.02, 2 + Math.random(), 4),
                    rebarMat
                );
                rebar.position.set(
                    (Math.random() - 0.5) * 2,
                    0.5 + Math.random(),
                    (Math.random() - 0.5) * 1
                );
                rebar.rotation.z = (Math.random() - 0.5) * 1.5;
                rebar.rotation.x = (Math.random() - 0.5) * 0.5;
                group.add(rebar);
            }
        }
    }

    /* ========================================================
     *  GROUND - 砂漠の地面（頂点カラーで変化をつける）
     * ======================================================== */
    _buildGround() {
        // メイン地面: 頂点カラーで砂紋の変化をつける
        const groundGeo = new THREE.PlaneGeometry(200, 40, 50, 10);
        const colors = [];
        const baseColor = new THREE.Color(0xD4A868);
        const shadowColor = new THREE.Color(0xA07838);
        const highlightColor = new THREE.Color(0xECC888);
        const pos = groundGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const y = pos.getY(i);
            // ノイズ風の変化（波+ランダム）
            const noise = Math.sin(x * 0.18) * 0.5 + Math.sin(y * 0.25 + 1) * 0.5 + Math.random() * 0.3 - 0.15;
            const c = new THREE.Color();
            if (noise > 0.2) {
                c.copy(highlightColor).lerp(baseColor, 1 - Math.min(1, noise - 0.2));
            } else if (noise < -0.2) {
                c.copy(shadowColor).lerp(baseColor, 1 - Math.min(1, -noise - 0.2));
            } else {
                c.copy(baseColor);
            }
            colors.push(c.r, c.g, c.b);
            // Y方向にわずかに高さをつけて砂丘風に
            pos.setZ(i, Math.sin(x * 0.12) * 0.08 + Math.sin(y * 0.3) * 0.04);
        }
        groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        groundGeo.computeVertexNormals();

        const groundMat = new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.98,
            metalness: 0.0,
        });
        this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
        this.groundMesh.rotation.x = -Math.PI / 2;
        this.groundMesh.position.y = -0.01;
        this.groundMesh.receiveShadow = true;
        this.scene.add(this.groundMesh);

        // 地面の道路/踏み固められた道（プレイ領域）— +Z 方向に沿って長い帯
        const roadGeo = new THREE.PlaneGeometry(8, 200);
        const roadMat = new THREE.MeshStandardMaterial({
            color: 0xB8956A,
            roughness: 0.88,
        });
        this.roadMesh = new THREE.Mesh(roadGeo, roadMat);
        this.roadMesh.rotation.x = -Math.PI / 2;
        this.roadMesh.position.y = 0.01;
        this.roadMesh.position.x = 0;
        this.roadMesh.receiveShadow = true;
        this.scene.add(this.roadMesh);

        // 道の端のわだち（暗い縞）— 道の横サイドに平行
        for (const xOff of [-2.2, 2.2]) {
            const rut = new THREE.Mesh(
                new THREE.PlaneGeometry(0.4, 200),
                new THREE.MeshStandardMaterial({ color: 0x7A5E38, roughness: 0.95 })
            );
            rut.rotation.x = -Math.PI / 2;
            rut.position.set(xOff, 0.02, 0);
            this.scene.add(rut);
            this.rutMeshes = this.rutMeshes || [];
            this.rutMeshes.push(rut);
        }
    }

    /* ========================================================
     *  CHUNKS - 地上の小道具・障害物（縦スクロール 3D 版）
     *  startZ: チャンクの開始 Z 座標（進行方向）
     *  オブジェクトの +Z が進行方向。±X は横スプレッド。
     * ======================================================== */
    _generateChunk(startZ) {
        const chunk = { startZ, objects: [] };

        const place = (obj, lateralRange = 10) => {
            obj.position.set(
                (Math.random() - 0.5) * lateralRange * 2,
                0,
                startZ + Math.random() * this.chunkSize
            );
            this.scene.add(obj);
            chunk.objects.push(obj);
        };

        // 土嚢（高確率）
        if (Math.random() > 0.2) place(this._buildSandbags(), 10);
        // 木箱
        if (Math.random() > 0.3) place(this._buildCrates(), 10);
        // ドラム缶
        if (Math.random() > 0.4) place(this._buildBarrels(), 10);
        // 鉄条網
        if (Math.random() > 0.55) place(this._buildBarbedWire(), 9);
        // テント
        if (Math.random() > 0.65) place(this._buildTent(), 9);
        // 壊れた壁
        if (Math.random() > 0.6) place(this._buildBrokenWall(), 9);
        // 木製の橋/桟橋
        if (Math.random() > 0.8) place(this._buildWoodenBridge(), 7);
        // サボテン（砂漠の象徴）- 道の外側に置く
        if (Math.random() > 0.5) {
            const cactus = this._buildCactus();
            cactus.position.set(
                (Math.random() > 0.5 ? 1 : -1) * (6 + Math.random() * 3),
                0,
                startZ + Math.random() * this.chunkSize
            );
            this.scene.add(cactus);
            chunk.objects.push(cactus);
        }
        // 岩の塊
        if (Math.random() > 0.4) place(this._buildRockCluster(), 12);
        // 砂山
        if (Math.random() > 0.6) place(this._buildSandPile(), 12);
        // 動物の骨/ドクロ
        if (Math.random() > 0.8) place(this._buildSkullBones(), 10);
        // 砂丘の低木
        if (Math.random() > 0.45) place(this._buildDesertShrubs(), 12);
        // 破れ布の旗杭
        if (Math.random() > 0.62) place(this._buildTornBannerPost(), 10);
        // 遺跡の柱片
        if (Math.random() > 0.72) place(this._buildRuinPillar(), 11);
        // キャラバン荷車跡
        if (Math.random() > 0.83) place(this._buildCaravanCart(), 9);

        this.chunks.push(chunk);
        this.lastChunkZ = startZ;
    }

    _buildDesertShrubs() {
        const group = new THREE.Group();
        const stemMat = new THREE.MeshStandardMaterial({ color: 0x64562E, roughness: 0.9 });
        const leafMat = new THREE.MeshStandardMaterial({ color: 0x7C8A42, roughness: 0.88 });
        const bushCount = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < bushCount; i++) {
            const rootX = (Math.random() - 0.5) * 2.8;
            const rootZ = (Math.random() - 0.5) * 1.6;
            for (let b = 0; b < 4; b++) {
                const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.3 + Math.random() * 0.25, 5), stemMat);
                stem.position.set(rootX + (Math.random() - 0.5) * 0.2, 0.12, rootZ + (Math.random() - 0.5) * 0.2);
                stem.rotation.z = (Math.random() - 0.5) * 0.9;
                group.add(stem);
            }
            for (let l = 0; l < 7; l++) {
                const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.08 + Math.random() * 0.07, 4, 3), leafMat);
                leaf.position.set(
                    rootX + (Math.random() - 0.5) * 0.35,
                    0.22 + Math.random() * 0.25,
                    rootZ + (Math.random() - 0.5) * 0.35
                );
                leaf.scale.y = 0.55;
                group.add(leaf);
            }
        }
        return group;
    }

    _buildTornBannerPost() {
        const group = new THREE.Group();
        const postMat = new THREE.MeshStandardMaterial({ color: 0x6B5539, roughness: 0.86 });
        const clothMat = new THREE.MeshStandardMaterial({
            color: Math.random() > 0.5 ? 0xAA2E1F : 0x2D4F7A,
            roughness: 0.92,
            side: THREE.DoubleSide,
        });
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 3.2, 6), postMat);
        post.position.y = 1.6;
        post.rotation.z = (Math.random() - 0.5) * 0.15;
        group.add(post);

        for (let i = 0; i < 3; i++) {
            const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.5 + i * 0.18, 0.2 + i * 0.04), clothMat);
            cloth.position.set(0.16 + i * 0.2, 2.6 - i * 0.35, 0);
            cloth.rotation.y = Math.PI / 2;
            cloth.rotation.z = -0.08 - i * 0.12;
            group.add(cloth);
        }

        const baseStone = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.3, 0.2, 8),
            new THREE.MeshStandardMaterial({ color: 0x8A7355, roughness: 0.95 })
        );
        baseStone.position.y = 0.1;
        group.add(baseStone);
        return group;
    }

    _buildRuinPillar() {
        const group = new THREE.Group();
        const stone = new THREE.MeshStandardMaterial({ color: 0xB79A72, roughness: 0.95, flatShading: true });
        const dark = new THREE.MeshStandardMaterial({ color: 0x8A7154, roughness: 0.96, flatShading: true });

        const h = 2.4 + Math.random() * 1.8;
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, h, 7), stone);
        shaft.position.y = h / 2;
        shaft.rotation.z = (Math.random() - 0.5) * 0.18;
        group.add(shaft);

        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.22, 0.7), dark);
        cap.position.y = h + 0.08;
        group.add(cap);

        for (let i = 0; i < 6; i++) {
            const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09 + Math.random() * 0.12, 0), i % 2 ? stone : dark);
            chip.position.set((Math.random() - 0.5) * 1.2, 0.06 + Math.random() * 0.2, (Math.random() - 0.5) * 1.1);
            group.add(chip);
        }
        return group;
    }

    _buildCaravanCart() {
        const group = new THREE.Group();
        const wood = new THREE.MeshStandardMaterial({ color: 0x7A5530, roughness: 0.88 });
        const metal = new THREE.MeshStandardMaterial({ color: 0x4A4A45, roughness: 0.55, metalness: 0.45 });
        const cloth = new THREE.MeshStandardMaterial({ color: 0xB78D4A, roughness: 0.92 });

        const bed = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.2, 1.2), wood);
        bed.position.y = 0.65;
        group.add(bed);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.25, 0.08), wood);
        rail.position.set(0, 0.82, 0.56);
        group.add(rail);
        const rail2 = rail.clone();
        rail2.position.z = -0.56;
        group.add(rail2);

        for (const x of [-0.85, 0.85]) {
            const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 6, 12), metal);
            wheel.position.set(x, 0.4, 0.74);
            wheel.rotation.y = Math.PI / 2;
            group.add(wheel);
            const wheel2 = wheel.clone();
            wheel2.position.z = -0.74;
            group.add(wheel2);
        }

        const canopy = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.7, 10, 1, true, 0, Math.PI), cloth);
        canopy.rotation.z = Math.PI / 2;
        canopy.position.set(0, 1.28, 0);
        group.add(canopy);

        for (let i = 0; i < 4; i++) {
            const sack = new THREE.Mesh(
                new THREE.SphereGeometry(0.17 + Math.random() * 0.06, 6, 4),
                new THREE.MeshStandardMaterial({ color: 0x9A7B4E, roughness: 0.9 })
            );
            sack.position.set((Math.random() - 0.5) * 1.2, 0.86 + Math.random() * 0.15, (Math.random() - 0.5) * 0.6);
            sack.scale.y = 0.7;
            group.add(sack);
        }
        return group;
    }

    /* --- サボテン（Metal Slug風砂漠のアクセント） --- */
    _buildCactus() {
        const group = new THREE.Group();
        const cactusMat = new THREE.MeshStandardMaterial({
            color: 0x4B6B3A, roughness: 0.85,
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x2E4522, roughness: 0.9,
        });

        // 本体
        const h = 1.8 + Math.random() * 1.2;
        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.22, 0.26, h, 8),
            cactusMat
        );
        trunk.position.y = h / 2;
        trunk.castShadow = true;
        group.add(trunk);

        // 腕（左右）
        if (Math.random() > 0.3) {
            for (const side of [-1, 1]) {
                if (Math.random() > 0.3) {
                    const armH = 0.7 + Math.random() * 0.5;
                    const arm = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.13, 0.16, armH, 8),
                        cactusMat
                    );
                    arm.position.set(side * 0.28, h * 0.6 + armH / 2, 0);
                    group.add(arm);
                    // 水平部分
                    const horiz = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.14, 0.16, 0.4, 8),
                        cactusMat
                    );
                    horiz.position.set(side * 0.15, h * 0.6, 0);
                    horiz.rotation.z = Math.PI / 2;
                    group.add(horiz);
                }
            }
        }

        // トゲ（小さな白い点）
        const spineMat = new THREE.MeshBasicMaterial({ color: 0xFFFFDD });
        for (let i = 0; i < 20; i++) {
            const spine = new THREE.Mesh(
                new THREE.SphereGeometry(0.015, 3, 2),
                spineMat
            );
            const a = Math.random() * Math.PI * 2;
            spine.position.set(
                Math.cos(a) * 0.24,
                0.2 + Math.random() * (h - 0.2),
                Math.sin(a) * 0.24
            );
            group.add(spine);
        }
        // 縦の溝の陰影
        for (let i = 0; i < 4; i++) {
            const stripe = new THREE.Mesh(
                new THREE.BoxGeometry(0.02, h - 0.2, 0.02),
                darkMat
            );
            const a = (i / 4) * Math.PI * 2;
            stripe.position.set(Math.cos(a) * 0.23, h / 2, Math.sin(a) * 0.23);
            group.add(stripe);
        }
        return group;
    }

    /* --- 岩の塊 --- */
    _buildRockCluster() {
        const group = new THREE.Group();
        const rockMat = new THREE.MeshStandardMaterial({
            color: 0x8B6E4A, roughness: 0.98, flatShading: true,
        });
        const darkRockMat = new THREE.MeshStandardMaterial({
            color: 0x6B4E30, roughness: 0.98, flatShading: true,
        });
        const count = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < count; i++) {
            const size = 0.3 + Math.random() * 0.8;
            const geo = new THREE.DodecahedronGeometry(size, 0);
            const rock = new THREE.Mesh(geo, i % 2 === 0 ? rockMat : darkRockMat);
            rock.position.set(
                (Math.random() - 0.5) * 2.5,
                size * 0.5,
                (Math.random() - 0.5) * 1.5
            );
            rock.rotation.set(Math.random(), Math.random(), Math.random());
            rock.castShadow = true;
            group.add(rock);
        }
        return group;
    }

    /* --- 砂山（小さな砂丘） --- */
    _buildSandPile() {
        const group = new THREE.Group();
        const sandMat = new THREE.MeshStandardMaterial({
            color: 0xD4A870, roughness: 0.98, flatShading: true,
        });
        // 円錐形の砂山
        const pile = new THREE.Mesh(
            new THREE.ConeGeometry(1.2 + Math.random() * 0.6, 0.5 + Math.random() * 0.4, 8),
            sandMat
        );
        pile.position.y = 0.25;
        pile.scale.set(1, 0.7, 0.9);
        group.add(pile);

        // 小さな石（ちらばり）
        const stoneMat = new THREE.MeshStandardMaterial({ color: 0x7B5A3A, roughness: 0.95 });
        for (let i = 0; i < 4; i++) {
            const stone = new THREE.Mesh(
                new THREE.DodecahedronGeometry(0.08 + Math.random() * 0.1, 0),
                stoneMat
            );
            stone.position.set(
                (Math.random() - 0.5) * 2,
                0.08,
                (Math.random() - 0.5) * 1.5
            );
            group.add(stone);
        }
        return group;
    }

    /* --- 動物の骨/ドクロ --- */
    _buildSkullBones() {
        const group = new THREE.Group();
        const boneMat = new THREE.MeshStandardMaterial({
            color: 0xE8D8B8, roughness: 0.85,
        });

        // 頭蓋骨（角付き）
        const skull = new THREE.Mesh(
            new THREE.SphereGeometry(0.25, 8, 6),
            boneMat
        );
        skull.scale.set(1.2, 0.9, 0.9);
        skull.position.y = 0.2;
        skull.rotation.y = (Math.random() - 0.5) * 0.5;
        group.add(skull);

        // 目の穴
        for (const zOff of [-0.09, 0.09]) {
            const eye = new THREE.Mesh(
                new THREE.SphereGeometry(0.05, 6, 4),
                new THREE.MeshBasicMaterial({ color: 0x1A1008 })
            );
            eye.position.set(0.18, 0.22, zOff);
            group.add(eye);
        }

        // 角（水牛風）
        for (const side of [-1, 1]) {
            const horn = new THREE.Mesh(
                new THREE.CylinderGeometry(0.03, 0.06, 0.5, 6),
                boneMat
            );
            horn.position.set(0, 0.38, side * 0.15);
            horn.rotation.z = Math.PI / 2 - 0.3;
            horn.rotation.x = side * 0.4;
            group.add(horn);
        }

        // 肋骨（数本）
        for (let i = 0; i < 4; i++) {
            const rib = new THREE.Mesh(
                new THREE.TorusGeometry(0.12 + i * 0.04, 0.015, 4, 8, Math.PI),
                boneMat
            );
            rib.position.set(-0.5 - i * 0.15, 0.05, 0);
            rib.rotation.z = Math.PI;
            group.add(rib);
        }

        // 脊椎
        const spine = new THREE.Mesh(
            new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6),
            boneMat
        );
        spine.position.set(-0.5, 0.05, 0);
        spine.rotation.z = Math.PI / 2;
        group.add(spine);

        return group;
    }

    _buildSandbags() {
        const group = new THREE.Group();
        const bagMat = new THREE.MeshStandardMaterial({ color: 0xAA9966, roughness: 0.95 });
        const rows = 2 + Math.floor(Math.random() * 2);
        for (let row = 0; row < rows; row++) {
            const bagsInRow = 3 - row;
            for (let i = 0; i < bagsInRow; i++) {
                const bag = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.35, 0.5), bagMat);
                bag.position.set((i - (bagsInRow - 1) / 2) * 0.85, row * 0.35 + 0.175, 0);
                bag.rotation.y = (Math.random() - 0.5) * 0.1;
                group.add(bag);
            }
        }
        return group;
    }

    _buildCrates() {
        const group = new THREE.Group();
        const crateMat = new THREE.MeshStandardMaterial({ color: 0x8B6B3B, roughness: 0.85 });
        const stripeMat = new THREE.MeshStandardMaterial({ color: 0x6B5B3B, roughness: 0.9 });
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
            const size = 0.6 + Math.random() * 0.4;
            const crate = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), crateMat);
            crate.position.set((Math.random() - 0.5) * 2, size / 2, (Math.random() - 0.5) * 1);
            crate.rotation.y = Math.random() * 0.5;
            crate.castShadow = true;
            group.add(crate);

            const stripe = new THREE.Mesh(new THREE.BoxGeometry(size + 0.02, 0.05, size + 0.02), stripeMat);
            stripe.position.copy(crate.position);
            stripe.position.y += size * 0.2;
            stripe.rotation.y = crate.rotation.y;
            group.add(stripe);
        }

        // 軍用マーキング（星マーク）
        if (Math.random() > 0.5) {
            const star = new THREE.Mesh(
                new THREE.CircleGeometry(0.15, 5),
                new THREE.MeshStandardMaterial({ color: 0xDDDD88, side: THREE.DoubleSide })
            );
            star.position.set(0, 0.5, 0.52);
            group.add(star);
        }
        return group;
    }

    _buildBarrels() {
        const group = new THREE.Group();
        const count = 1 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) {
            const isRed = Math.random() > 0.5;
            const barrel = new THREE.Mesh(
                new THREE.CylinderGeometry(0.35, 0.35, 0.9, 10),
                new THREE.MeshStandardMaterial({
                    color: isRed ? 0xAA3333 : 0x556655,
                    roughness: 0.6, metalness: 0.3,
                })
            );
            barrel.position.set((Math.random() - 0.5) * 1.5, 0.45, (Math.random() - 0.5) * 1);
            if (Math.random() > 0.7) {
                barrel.rotation.z = Math.PI / 2;
                barrel.position.y = 0.35;
            }
            barrel.castShadow = true;
            group.add(barrel);

            // ラベル/ストライプ
            const label = new THREE.Mesh(
                new THREE.CylinderGeometry(0.36, 0.36, 0.15, 10),
                new THREE.MeshStandardMaterial({
                    color: isRed ? 0xDD5555 : 0x667766,
                    roughness: 0.5,
                })
            );
            label.position.copy(barrel.position);
            label.rotation.copy(barrel.rotation);
            group.add(label);
        }
        return group;
    }

    _buildBarbedWire() {
        const group = new THREE.Group();
        const postMat = new THREE.MeshStandardMaterial({ color: 0x5A5A5A, roughness: 0.6, metalness: 0.4 });
        for (let i = 0; i < 3; i++) {
            const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5, 4), postMat);
            post.position.set(i * 1.5, 0.75, 0);
            group.add(post);
        }
        const wireMat = new THREE.MeshBasicMaterial({ color: 0x888888 });
        for (let h = 0.5; h <= 1.3; h += 0.4) {
            const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 3, 4), wireMat);
            wire.rotation.z = Math.PI / 2;
            wire.position.set(1.5, h, 0);
            group.add(wire);
        }
        return group;
    }

    _buildTent() {
        const group = new THREE.Group();
        const tentMat = new THREE.MeshStandardMaterial({
            color: 0x7B8B5B, roughness: 0.9, side: THREE.DoubleSide,
        });
        const tentShape = new THREE.Shape();
        tentShape.moveTo(-2, 0);
        tentShape.lineTo(0, 2);
        tentShape.lineTo(2, 0);
        const tentGeo = new THREE.ExtrudeGeometry(tentShape, { depth: 2.5, bevelEnabled: false });
        const tent = new THREE.Mesh(tentGeo, tentMat);
        tent.position.set(0, 0, -1.25);
        group.add(tent);

        // ポール
        const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.05, 2.2, 4),
            new THREE.MeshStandardMaterial({ color: 0x5A4A3A, roughness: 0.8 })
        );
        pole.position.set(0, 1.1, 0);
        group.add(pole);
        return group;
    }

    _buildBrokenWall() {
        const group = new THREE.Group();
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x9B8B7B, roughness: 0.95 });
        // 壊れた壁の断片
        const h = 1.5 + Math.random() * 2;
        const w = 2 + Math.random() * 2;
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), wallMat);
        wall.position.y = h / 2;
        wall.rotation.y = (Math.random() - 0.5) * 0.3;
        group.add(wall);

        // 壊れた端（不規則な形）
        for (let d = 0; d < 3; d++) {
            const debSize = 0.2 + Math.random() * 0.4;
            const deb = new THREE.Mesh(
                new THREE.BoxGeometry(debSize, debSize, debSize),
                wallMat
            );
            deb.position.set(
                (Math.random() - 0.5) * w,
                Math.random() * 0.5,
                (Math.random() - 0.5) * 0.5
            );
            deb.rotation.set(Math.random(), Math.random(), Math.random());
            group.add(deb);
        }
        return group;
    }

    _buildWoodenBridge() {
        const group = new THREE.Group();
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B6B3B, roughness: 0.9 });
        const bridgeLen = 5 + Math.random() * 3;

        // 板
        for (let x = 0; x < bridgeLen; x += 0.5) {
            const plank = new THREE.Mesh(
                new THREE.BoxGeometry(0.45, 0.08, 2.0),
                woodMat
            );
            plank.position.set(x - bridgeLen / 2, 0.5, 0);
            plank.rotation.y = (Math.random() - 0.5) * 0.05;
            group.add(plank);
        }

        // 支柱
        for (let x of [-bridgeLen / 2, 0, bridgeLen / 2]) {
            for (let z of [-1.0, 1.0]) {
                const post = new THREE.Mesh(
                    new THREE.CylinderGeometry(0.08, 0.1, 1.0, 6),
                    woodMat
                );
                post.position.set(x, 0.0, z);
                group.add(post);
            }
        }

        // 手すり
        for (let z of [-1.05, 1.05]) {
            const rail = new THREE.Mesh(
                new THREE.BoxGeometry(bridgeLen + 0.5, 0.06, 0.06),
                woodMat
            );
            rail.position.set(0, 0.9, z);
            group.add(rail);
        }
        return group;
    }

    /* ========================================================
     *  RESET
     * ======================================================== */
    reset(scrollZ) {
        this.chunks.forEach(chunk => {
            chunk.objects.forEach(obj => {
                this.scene.remove(obj);
                obj.traverse(child => {
                    if (child.isMesh) {
                        child.geometry.dispose();
                        if (child.material.dispose) child.material.dispose();
                    }
                });
            });
        });
        this.chunks = [];
        this.lastChunkZ = scrollZ - this.chunkSize;
        for (let z = scrollZ - this.chunkSize; z <= scrollZ + this.chunkSize * 2; z += this.chunkSize) {
            this._generateChunk(z);
        }
    }

    /* ========================================================
     *  UPDATE
     * ======================================================== */
    update(dt, scrollZ) {
        // 地面・道路・空の +Z 追従
        if (this.groundMesh) this.groundMesh.position.z = scrollZ;
        if (this.roadMesh) this.roadMesh.position.z = scrollZ;
        if (this.skyMesh) this.skyMesh.position.z = scrollZ;
        if (this.skyPhotoMesh) this.skyPhotoMesh.position.z = scrollZ;
        if (this.rutMeshes) {
            this.rutMeshes.forEach(r => r.position.z = scrollZ);
        }

        if (this.photoForegroundMeshes.length > 0) {
            this.photoForegroundMeshes.forEach((entry) => {
                if (entry.isFront) {
                    entry.mesh.position.z = scrollZ + 56;
                } else {
                    entry.mesh.position.z = scrollZ;
                }
            });
        }

        // 雲は横 (X) 方向へゆっくり drift、Z 方向へはプレイヤーの前後でラップ
        this.clouds.forEach(c => {
            c.group.position.x += c.speed * dt * 0.5;
            if (c.group.position.z > scrollZ + 90) c.group.position.z -= 180;
            else if (c.group.position.z < scrollZ - 90) c.group.position.z += 180;
        });

        // パララックス背景: +Z 方向へラップ
        this.bgLayers.forEach(layer => {
            layer.objects.forEach(obj => {
                const relZ = obj.position.z - scrollZ * layer.parallaxRate;
                if (relZ < -90) obj.position.z += 180;
                else if (relZ > 90) obj.position.z -= 180;
            });
        });

        // チャンク生成（前方 +Z）
        while (this.lastChunkZ < scrollZ + this.viewRange) {
            this._generateChunk(this.lastChunkZ + this.chunkSize);
        }

        // チャンク削除（後方 -Z）
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            const chunk = this.chunks[i];
            if (chunk.startZ + this.chunkSize < scrollZ - this.cleanupRange) {
                chunk.objects.forEach(obj => {
                    this.scene.remove(obj);
                    obj.traverse(child => {
                        if (child.isMesh) {
                            child.geometry.dispose();
                            if (child.material.dispose) child.material.dispose();
                        }
                    });
                });
                this.chunks.splice(i, 1);
            }
        }
    }
}
