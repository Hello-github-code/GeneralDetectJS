// const resnetModelPath = 'models/resnet-v2-tfjs-50-feature-vector-v2/model.json';
const yoloModelPath = 'models/yolo11s_web_model/model.json';

const labels = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
    "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
    "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
    "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
    "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush"
];

let yoloModel = null;
let featureModel = null;

async function loadModel() {
    const models = await tf.io.listModels();
    console.log('当前缓存的模型:', models);

    try {
        if (models['indexeddb://yolo11s_web_model']) {
            yoloModel = await tf.loadGraphModel('indexeddb://yolo11s_web_model');
            console.log("成功从缓存中加载yolo模型");
        } else {
            throw new Error('yolo模型在缓存中未找到');
        }
    } catch (error) {
        console.error('从缓存加载yolo模型失败:', error);
        yoloModel = await tf.loadGraphModel(yoloModelPath);
        console.log("成功从本地加载yolo模型");
        try {
            await yoloModel.save('indexeddb://yolo11s_web_model');
            console.log("成功将yolo模型保存到缓存");
        } catch (saveError) {
            console.error('保存yolo模型到缓存失败:', saveError);
        }
    }

    try {
        if (models['indexeddb://mobilenet-model']) {
            featureModel = await tf.loadGraphModel('indexeddb://mobilenet-model');
            console.log("成功从缓存中加载mobilenet模型");
        } else {
            throw new Error('mobilenet模型在缓存中未找到');
        }
    } catch (error) {
        console.error('从缓存加载mobilenet模型失败:', error);
        // featureModel = await tf.loadGraphModel(resnetModelPath);
        const mobileNetModel = await mobilenet.load({
            version: 2,
            alpha: 1.0
        });
        featureModel = mobileNetModel.model;    // 获取内部的 tf.GraphModel
        console.log("成功从CDN加载mobilenet模型");
        try {
            await featureModel.save('indexeddb://mobilenet-model');
            console.log("成功将mobilenet模型保存到缓存");
        } catch (saveError) {
            console.error('保存mobilenet模型到缓存失败:', saveError);
        }
    }

    return [yoloModel, featureModel];
}

async function preprocessImage(img) {
    return tf.tidy(() =>
        tf.browser.fromPixels(img)
            .resizeBilinear([224, 224])
            .div(255.0)
            .expandDims()
    );
}

async function extractDeepFeatures(image) {
    let tensor = null;
    let features = null;
    try {
        tensor = await preprocessImage(image);
        features = await featureModel.predict(tensor);
        const featureArray = await features.data();

        console.log('特征提取成功，特征维度:', featureArray.length);
        return featureArray;
    } catch (error) {
        console.error('特征提取失败:', error);
        return null;
    } finally {
        if (tensor) tensor.dispose();
        if (features) features.dispose();
    }
}

async function extractMultiScaleFeatures(image) {
    const angles = [0, 90, 180, 270];
    const scales = [2];
    let allFeatures = [];

    try {
        for (const scale of scales) {
            for (const angle of angles) {
                const rotatedCanvas = document.createElement('canvas');
                const rotatedCtx = rotatedCanvas.getContext('2d');

                // 计算旋转后的尺寸
                const diagonal = Math.sqrt(image.width * image.width + image.height * image.height);
                rotatedCanvas.width = diagonal;
                rotatedCanvas.height = diagonal;

                // 在canvas中心进行旋转
                rotatedCtx.translate(diagonal / 2, diagonal / 2);
                rotatedCtx.rotate(angle * Math.PI / 180);
                rotatedCtx.drawImage(
                    image,
                    -image.width / 2, -image.height / 2,
                    image.width, image.height
                );

                // 缩放处理
                let scaledCanvas;
                if (rotatedCanvas.width * rotatedCanvas.height < 30000) {
                    scaledCanvas = document.createElement('canvas');
                    const scaledCtx = scaledCanvas.getContext('2d');
                    scaledCanvas.width = Math.round(rotatedCanvas.width * scale);
                    scaledCanvas.height = Math.round(rotatedCanvas.height * scale);
                    scaledCtx.drawImage(
                        rotatedCanvas,
                        0, 0,
                        scaledCanvas.width, scaledCanvas.height
                    );
                } else {
                    scaledCanvas = rotatedCanvas;
                }

                const features = await extractDeepFeatures(scaledCanvas);
                if (features) {
                    allFeatures.push(features);
                }

                rotatedCanvas.width = 1;
                rotatedCanvas.height = 1;
                scaledCanvas.width = 1;
                scaledCanvas.height = 1;
            }
        }

        if (allFeatures.length === 0) {
            console.error('特征提取失败');
            return null;
        }

        // 融合所有特征
        const combinedFeatures = new Array(allFeatures[0].length).fill(0);
        for (let i = 0; i < combinedFeatures.length; i++) {
            combinedFeatures[i] = Math.max(...allFeatures.map(f => f[i]));
        }

        return combinedFeatures;
    } catch (error) {
        console.error('特征提取错误:', error);
        return null;
    }
}

function computeSimilarity(feature1, feature2) {
    try {
        if (!feature1 || !feature2 || feature1.length !== feature2.length) {
            return 0;
        }

        // 曼哈顿距离
        let manhattanDistance = 0;
        for (let i = 0; i < feature1.length; i++) {
            manhattanDistance += Math.abs(feature1[i] - feature2[i]);
        }
        const manhattanSimilarity = 1 / (1 + manhattanDistance);

        // 欧氏距离
        let euclideanDistance = 0;
        for (let i = 0; i < feature1.length; i++) {
            euclideanDistance += Math.pow(feature1[i] - feature2[i], 2);
        }
        euclideanDistance = Math.sqrt(euclideanDistance);
        const euclideanSimilarity = 1 / (1 + euclideanDistance);

        // 余弦相似度
        let dotProduct = 0;
        let magnitudeA = 0;
        let magnitudeB = 0;
        for (let i = 0; i < feature1.length; i++) {
            dotProduct += feature1[i] * feature2[i];
            magnitudeA += feature1[i] * feature1[i];
            magnitudeB += feature2[i] * feature2[i];
        }
        magnitudeA = Math.sqrt(magnitudeA);
        magnitudeB = Math.sqrt(magnitudeB);
        const cosineSimilarity = dotProduct / (magnitudeA * magnitudeB);

        console.log('相似度详情:', {
            曼哈顿相似度: manhattanSimilarity.toFixed(4),
            欧氏相似度: euclideanSimilarity.toFixed(4),
            余弦相似度: cosineSimilarity.toFixed(4)
        });

        return manhattanSimilarity + euclideanSimilarity + cosineSimilarity;
    } catch (error) {
        console.error('计算相似度时出错:', error);
        return 0;
    }
}

class YoloDetector {
    constructor() {
        this.initialized = false;
        this.inputShape = null;
        this.templateFeature = [];
        this.templateClass = null;
        this.init();
        this.minSimilarityThreshold = 0.37;
        this.maxSimilarityThreshold = 0.47;
        this.categoryGroups = {
            '餐具': ['fork', 'knife', 'spoon', 'bowl', 'cup', 'wine glass', 'bottle'],
            '电子设备': ['tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone'],
            '家具': ['chair', 'couch', 'bed', 'dining table', 'bench'],
            '厨房电器': ['microwave', 'oven', 'toaster', 'refrigerator', 'sink'],
            '食物': ['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake'],
            '交通工具': ['bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat'],
            '动物': ['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'],
            '运动器材': ['frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket']
        };
    }

    async init() {
        try {
            [yoloModel, featureModel] = await loadModel();
            this.inputShape = yoloModel.inputs[0].shape;
            this.initialized = this.inputShape != null;
            console.log("模型初始化完成");
        } catch (error) {
            console.error("模型初始化失败:", error);
            this.initialized = false;
        }
    }

    async getTemplate(template) {
        if (!this.initialized) {
            console.error('模型未初始化');
            [yoloModel, featureModel] = await loadModel();
            console.log("模型加载成功");
            this.inputShape = yoloModel.inputs[0].shape;
            this.initialized = this.inputShape != null;
        }

        this.templateFeature = [];
        this.templateClass = null;

        const detections = await this.generalDetect(template);
        if (detections.length === 0) {
            console.error('模板特征提取失败');
            return -1;
        }

        let maxPixelDetection = null;
        let maxPixelCount = 0;
        for (let detection of detections) {
            if (['person', 'tv', 'laptop', 'bench', 'chair', 'couch', 'bed',
                'dining table', 'refrigerator', 'toilet', 'book', 'sink', 'microwave', 'oven',
                'potted plant', 'traffic light', 'stop sign', 'parking meter'].includes(detection.class)) {
                continue;
            }

            const pixelCount = detection.bbox.width * detection.bbox.height;
            if (pixelCount > maxPixelCount) {
                maxPixelCount = pixelCount;
                maxPixelDetection = detection;
            }
        }

        if (maxPixelDetection) {
            const { x, y, width, height } = maxPixelDetection.bbox;
            const roiCanvas = document.createElement('canvas');
            const roiCtx = roiCanvas.getContext('2d');
            roiCanvas.width = width;
            roiCanvas.height = height;
            roiCtx.drawImage(template, x, y, width, height, 0, 0, width, height);

            const features = await extractMultiScaleFeatures(roiCanvas);
            if (features == null) {
                console.error('模板特征提取失败');
                return -1;
            }

            this.templateClass = maxPixelDetection.class;
            console.log('模板类别:', this.templateClass);
            this.templateFeature.push(features);
        }

        if (this.templateFeature.length == 0) {
            console.error('模板特征提取失败');
            return -1;
        }

        return 0;
    }

    calculateAdaptiveThreshold(objectSize) {
        const minSize = 0.01;
        const maxSize = 0.2;

        const sizeRatio = Math.min(Math.max((objectSize - minSize) / (maxSize - minSize), 0), 1);
        const nonLinearRatio = Math.pow(sizeRatio, 0.3);

        const threshold = this.minSimilarityThreshold +
            (this.maxSimilarityThreshold - this.minSimilarityThreshold) * nonLinearRatio;

        console.log('阈值计算:', {
            非线性比例: nonLinearRatio.toFixed(4),
            最终阈值: threshold.toFixed(4)
        });

        return threshold;
    }

    getCategory(className) {
        for (const [category, items] of Object.entries(this.categoryGroups)) {
            if (items.includes(className)) {
                return category;
            }
        }
        return className; // 如果没有找到对应的类别组，返回原始类别
    }

    async detect(image, options = {}) {
        if (!this.initialized) {
            console.error('模型未初始化');
            [yoloModel, featureModel] = await loadModel();
            console.log("模型加载成功");
            this.inputShape = yoloModel.inputs[0].shape;
            this.initialized = this.inputShape != null;
        }

        try {
            const detections = await this.generalDetect(image, options);
            if (detections.length == 0) {
                console.log('未检测到目标');
                return [];
            }

            let results = [];
            const templateCategory = this.getCategory(this.templateClass);

            for (let detection of detections) {
                const detectionCategory = this.getCategory(detection.class);
                if (detectionCategory !== templateCategory) {
                    console.log(`跳过不匹配的类别组: ${detectionCategory}, 期望类别组: ${templateCategory}`);
                    continue;
                }

                const { x, y, width, height } = detection.bbox;
                const roiCanvas = document.createElement('canvas');
                const roiCtx = roiCanvas.getContext('2d');
                roiCanvas.width = width;
                roiCanvas.height = height;
                roiCtx.drawImage(image, x, y, width, height, 0, 0, width, height);

                const features = await extractMultiScaleFeatures(roiCanvas);

                roiCanvas.width = 1;
                roiCanvas.height = 1;

                if (!features) continue;

                let maxSimilarity = 0;
                for (let templateFeature of this.templateFeature) {
                    const similarity = computeSimilarity(templateFeature, features);
                    maxSimilarity = Math.max(maxSimilarity, similarity);
                }

                const objectSize = (width * height) / (image.width * image.height);
                const adaptiveThreshold = this.calculateAdaptiveThreshold(objectSize);

                if (maxSimilarity > adaptiveThreshold) {
                    results.push({
                        x, y, width, height,
                        similarity: maxSimilarity,
                        threshold: adaptiveThreshold,
                        class: detection.class
                    });
                }
            }

            if (results.length == 0) {
                console.log(`未找到匹配的${this.templateClass}目标`);
                return [];
            }

            // 选择最佳匹配结果
            const bestResult = results.reduce((best, current) => {
                const bestScore = best.similarity;
                const currentScore = current.similarity;
                // const bestScore = best.similarity / best.threshold;
                // const currentScore = current.similarity / current.threshold;                
                return currentScore > bestScore ? current : best;
            }, results[0]);

            const x_center = (bestResult.x + bestResult.width / 2) / image.width;
            const y_center = (bestResult.y + bestResult.height / 2) / image.height;

            console.log('检测结果:', {
                x: x_center,
                y: y_center,
                width: bestResult.width / image.width,
                height: bestResult.height / image.height,
                similarity: bestResult.similarity,
                threshold: bestResult.threshold,
                class: bestResult.class
            });

            return [{
                x: x_center,
                y: y_center,
                width: bestResult.width / image.width,
                height: bestResult.height / image.height,
                class: bestResult.class
            }];

        } catch (error) {
            console.error('检测过程发生错误:', error);
            return [];
        }
    }

    yoloPreprocess(image) {
        if (!image) { throw new Error('输入图像不能为空'); }

        return tf.tidy(() => {
            let tensor = tf.browser.fromPixels(image);
            const [h, w] = tensor.shape.slice(0, 2);
            const maxSize = Math.max(w, h);
            const padding = [[0, maxSize - h], [0, maxSize - w], [0, 0]];
            const paddedTensor = tensor.pad(padding);

            const normalizedTensor = tf.image
                .resizeBilinear(paddedTensor, [this.inputShape[1], this.inputShape[2]])
                .div(255.0)
                .expandDims(0);

            return {
                tensor: normalizedTensor,
                scale: {
                    x: this.inputShape[1] / maxSize,
                    y: this.inputShape[2] / maxSize,
                    originalWidth: w,
                    originalHeight: h
                }
            };
        });
    }

    async generalDetect(image, options = {}) {
        if (!this.initialized) { throw new Error("请先调用initialize()初始化模型"); }

        const defaults = {
            scoreThreshold: 0.35,
            iouThreshold: 0.45,
            maxDetections: 20
        };
        const config = { ...defaults, ...options };

        let tensors = [];
        try {
            const { tensor: inputTensor, scale } = this.yoloPreprocess(image);
            tensors.push(inputTensor);

            const result = await yoloModel.execute(inputTensor);
            const outputs = Array.isArray(result) ? result : [result];
            tensors.push(...outputs);

            const boxesOutput = outputs[0];
            const masksOutput = outputs.length > 1 ? outputs[1] : null;

            const transposedBoxes = boxesOutput.transpose([0, 2, 1]);
            tensors.push(transposedBoxes);

            // 使用tf.tidy处理同步操作
            const [boxes, scores, classes] = tf.tidy(() => {
                const w = transposedBoxes.slice([0, 0, 2], [-1, -1, 1]);
                const h = transposedBoxes.slice([0, 0, 3], [-1, -1, 1]);
                const x1 = tf.sub(transposedBoxes.slice([0, 0, 0], [-1, -1, 1]), tf.div(w, 2));
                const y1 = tf.sub(transposedBoxes.slice([0, 0, 1], [-1, -1, 1]), tf.div(h, 2));
                const boxes = tf.concat([y1, x1, tf.add(y1, h), tf.add(x1, w)], 2).squeeze();

                const scoresStart = 4;
                const rawScores = transposedBoxes.slice([0, 0, scoresStart], [-1, -1, labels.length]).squeeze();
                return [boxes, rawScores.max(1), rawScores.argMax(1)];
            });
            tensors.push(boxes, scores, classes);

            // 执行NMS
            const selectedIndices = await tf.image.nonMaxSuppressionAsync(
                boxes, scores, config.maxDetections, config.iouThreshold, config.scoreThreshold
            );

            // 收集结果
            const boxesData = boxes.gather(selectedIndices).dataSync();
            const scoresData = scores.gather(selectedIndices).dataSync();
            const classesData = classes.gather(selectedIndices).dataSync();
            const masksData = masksOutput ? masksOutput.gather(selectedIndices).dataSync() : null;

            const validDetections = [];
            for (let i = 0; i < scoresData.length; i++) {
                if (isNaN(scoresData[i]) || scoresData[i] < config.scoreThreshold) continue;

                // 将检测框坐标转换回原图尺寸
                const [y1, x1, y2, x2] = boxesData.slice(i * 4, (i + 1) * 4);
                const originalX1 = (x1 / scale.x);
                const originalY1 = (y1 / scale.y);
                const originalX2 = (x2 / scale.x);
                const originalY2 = (y2 / scale.y);

                if (originalX1 >= originalX2 || originalY1 >= originalY2) continue;

                // 提取对应的掩码数据
                let mask = null;
                if (masksData) {
                    const maskWidth = Math.round(originalX2 - originalX1);
                    const maskHeight = Math.round(originalY2 - originalY1);
                    try {
                        mask = new Float32Array(masksData.slice(
                            i * maskWidth * maskHeight,
                            (i + 1) * maskWidth * maskHeight
                        ));
                    } catch (error) {
                        console.warn('掩码数据提取失败:', error);
                        mask = null;
                    }
                }

                validDetections.push({
                    bbox: {
                        x: originalX1,
                        y: originalY1,
                        width: originalX2 - originalX1,
                        height: originalY2 - originalY1
                    },
                    class: labels[classesData[i]],
                    score: scoresData[i],
                    mask: mask
                });
            }

            tensors.forEach(t => t && t.dispose());

            if (!validDetections.length) {
                console.log('没有检测到任何目标');
            } else {
                console.log(`检测到 ${validDetections.length} 个目标`);
            }

            return validDetections;
        } catch (error) {
            console.error('检测过程中发生错误:', error);
            return [];
        }
    }

    release() {
        this.templateFeature = [];
        this.templateClass = null;
    }
}

// 将YoloDetector添加到window对象，使其成为全局可访问
window.YoloDetector = YoloDetector;