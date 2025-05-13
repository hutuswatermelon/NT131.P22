import cv2
from pathlib import Path
import argparse
import time

from src.lp_recognition import E2E

def get_arguments():
    arg = argparse.ArgumentParser()
    arg.add_argument('-i', '--image_path', help='link to image', default='./samples/1.jpg')

    return arg.parse_args()

args = get_arguments()
img_path = Path(args.image_path)

# read image
img = cv2.imread(str(img_path))

if img is None:
    print("NoPlate") # Output "NoPlate" if image can't be loaded
    exit() # Exit the script

# start
start = time.time()

# load model
model = E2E()

# recognize license plate
# The model.predict should return the license plate string directly or handle "NoPlate"
plate_text = model.predict(img) # Assuming model.predict returns the plate string or "NoPlate"

# end
# end_time = time.time()

# print('Model process on %.2f s' % (end_time - start_time)) # This goes to stderr if not careful, or stdout

# Output only the license plate to stdout for server.js
print(plate_text)

# cv2.destroyAllWindows() # Not needed when run as a script by server