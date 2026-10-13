#!/usr/bin/env python3
# The thumbnail kit's face analyser: MediaPipe's Face Landmarker over frames the kit's job
# (scripts/thumbnail-kit.mjs) streams to it, one face per frame, answering with what a thumbnail
# designer looks at in a face: where it is, how open the eyes are, the expression as the model's
# 52 blendshape scores, and which way the head points. With --hands, MediaPipe's Hand Landmarker
# also reads the hands of every frame that has a face, so the kit can tell a finger pointing from
# a finger over the nose.
#
# It runs in its own venv (scripts/setup-face.sh), never in WhisperX's. It decides nothing:
# scoring, tags and the choice of frames are core/thumbnail-kit.mjs, where they are tested
# without a model.
#
#   python scripts/face-analyse.py --model <face_landmarker.task> [--hands <hand_landmarker.task>]          serve frames on stdin
#   python scripts/face-analyse.py --model <face_landmarker.task> [--hands <hand_landmarker.task>] --check  load, analyse a blank frame, exit
#
# Protocol, one request at a time on stdin: a JSON line {"id", "w", "h", "encode"?, "quality"?}
# followed by exactly w*h*3 bytes of RGB. One JSON line comes back per request, in order:
# {"id", "face": {x, y, w, h} | null, "blendshapes": {...}, "pose": {yaw, pitch, roll}, "hands": [[[x, y] * 21]],
# "encoded"}, hand points normalised to the frame. "analyse": false skips the models (a screen
# frame only being encoded).
# With "encode" the frame is also written there as a JPEG at "quality" (95 by default), which is
# how the kit's frames get a true quality 95 rather than ffmpeg's nearest qscale. The first line
# out is {"ready": true, "mediapipe": <version>} once the model has loaded, or {"error": ...}.

import argparse
import json
import math
import sys
import time


def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_exact(stream, size):
    chunks = []
    left = size
    while left > 0:
        chunk = stream.read(left)
        if not chunk:
            return None
        chunks.append(chunk)
        left -= len(chunk)
    return b"".join(chunks)


# The facial transformation matrix maps MediaPipe's canonical face into camera space. Its rotation,
# read as Z·Y·X Euler angles, is the head's pose. Signs as the kit reports them, checked against
# real frames: yaw is positive when the face turns toward the frame's right edge (the nose points
# right), pitch is positive when the chin lifts and negative when the speaker looks down.
def pose_of(matrix):
    r = matrix
    pitch = math.degrees(math.atan2(r[2][1], r[2][2]))
    yaw = math.degrees(math.asin(max(-1.0, min(1.0, -r[2][0]))))
    roll = math.degrees(math.atan2(r[1][0], r[0][0]))
    return {"yaw": round(yaw, 1), "pitch": round(-pitch, 1), "roll": round(roll, 1)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--hands")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        import numpy as np
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import vision, BaseOptions
        options = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=args.model),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=1,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
        landmarker = vision.FaceLandmarker.create_from_options(options)
        hands = None
        if args.hands:
            hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=args.hands),
                running_mode=vision.RunningMode.IMAGE,
                num_hands=2,
                min_hand_detection_confidence=0.5,
                min_hand_presence_confidence=0.5,
            ))
    except Exception as error:  # a missing library, a bad model: the kit degrades and says why
        emit({"error": f"{type(error).__name__}: {error}"})
        return 1

    def analyse(rgb):
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        result = landmarker.detect(image)
        if not result.face_landmarks:
            return {"face": None}
        h, w = rgb.shape[0], rgb.shape[1]
        points = result.face_landmarks[0]
        xs = [p.x for p in points]
        ys = [p.y for p in points]
        x0 = max(0.0, min(xs)) * w
        y0 = max(0.0, min(ys)) * h
        x1 = min(1.0, max(xs)) * w
        y1 = min(1.0, max(ys)) * h
        face = {"x": round(x0), "y": round(y0), "w": max(1, round(x1 - x0)), "h": max(1, round(y1 - y0))}
        shapes = {c.category_name: round(float(c.score), 3) for c in result.face_blendshapes[0]} if result.face_blendshapes else {}
        pose = pose_of(np.array(result.facial_transformation_matrixes[0]).tolist()) if result.facial_transformation_matrixes else None
        answer = {"face": face, "blendshapes": shapes, "pose": pose}
        if hands is not None:
            found = hands.detect(image)
            answer["hands"] = [[[round(p.x, 3), round(p.y, 3)] for p in hand] for hand in found.hand_landmarks]
        return answer

    if args.check:
        started = time.time()
        found = analyse(np.zeros((360, 640, 3), dtype=np.uint8))
        landmarker.close()
        if hands is not None:
            hands.close()
        emit({"ready": True, "mediapipe": mp.__version__, "hands": hands is not None, "blank": found["face"] is None, "ms": round((time.time() - started) * 1000)})
        return 0

    emit({"ready": True, "mediapipe": mp.__version__, "hands": hands is not None})
    stdin = sys.stdin.buffer
    try:
        while True:
            line = stdin.readline()
            if not line:
                break
            if not line.strip():
                continue
            request = json.loads(line)
            w, h = int(request["w"]), int(request["h"])
            data = read_exact(stdin, w * h * 3)
            if data is None:
                break
            rgb = np.frombuffer(data, dtype=np.uint8).reshape((h, w, 3))
            answer = {"id": request.get("id")}
            if request.get("analyse", True):
                try:
                    answer.update(analyse(np.ascontiguousarray(rgb)))
                except Exception as error:
                    answer.update({"face": None, "error": f"{type(error).__name__}: {error}"})
            if request.get("encode"):
                quality = int(request.get("quality", 95))
                bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
                answer["encoded"] = bool(cv2.imwrite(request["encode"], bgr, [cv2.IMWRITE_JPEG_QUALITY, quality]))
            emit(answer)
    finally:
        landmarker.close()
        if hands is not None:
            hands.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
