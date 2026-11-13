Week 2:
  Author:
  Reviewer:

Sprint Dates: November 9 - 13, 2026

At the end of Sprint 1 we had paper prototypes and a feature list, but we had not decided how the interface and the backend would work together. Without that decision we could not start coordinated implementation. This week we chose the platform, set up a shared repository, and agreed with the other groups on the records we exchange. We also built the first working version of the Training tool: it imports and displays a TIFF, lets the user create classes, and lets them label individual pixels.

**Platform decision.** We compared five options against the requirements from our user stories and Sprint 1 features: a web app with React and Flask, React and FastAPI, Streamlit, a desktop app (PyQt / napari), and a QGIS plugin. The main requirements were reading multi-band 16-bit GeoTIFFs, picking a single exact pixel, keeping display changes separate from the stored values, sharing data with the Model group's Python code, and being easy for three groups to install. Streamlit could not give us the custom canvas interaction we need for labeling. The desktop and QGIS options would make it harder for each group to run as a separate service. We chose **React for the frontend and Flask with rasterio for the backend**. FastAPI would also have worked, but Flask was already familiar to the team and has a simpler learning curve.

**Image-loading experiment.** Before committing, we built a small experiment that loads the same 4-band (Red, Green, Blue, NIR) uint16 GeoTIFF at three sizes, up to 4096 × 4096. We compared four readers: rasterio, tifffile, Pillow and geotiff.js (reading in the browser). Pillow could not open the files at all, which showed that an ordinary image viewer will not work for satellite images. rasterio was the fastest reader and gave us the coordinate system and pixel-to-map conversion directly. It could read one pixel in about 3 ms at every image size. Reading in the browser was 4–7 times slower and used about 600 MB of memory for the largest image. Based on this, the backend reads the TIFF and sends the browser a display image, and the exact band values are always read from the original file when the user clicks. We also learned that a full-resolution preview of a large image is too heavy (34 MB). We now downsample the display to 2048 px, and tiling is a task for a later sprint.

**Shared data format.** Training examples and verification feedback must refer to the same image, location and class, so we wrote two example records and a JSON Schema for each. The *training example* contains the project ID, image ID, point ID, pixel ID, pixel row/column, map coordinates, class, original band values, approval status and source. The *correction request* contains the original prediction, model version, location (a point or a highlighted polygon), the requested action and an explanation. We fixed a few conventions that could cause errors between groups. Pixels are 0-based from the top-left corner, pixel ID = row × width + col, and map coordinates refer to the pixel centre. Classes use integer IDs, and only approved examples are used for training. We answered the Learning & Tools question about polygon densification: Training will split polygons into individual pixels before export. We also added a CSV export that matches their planned pandas dataframe. The correction request's add/remove/relabel actions match the two highlight colours Verification planned. We sent both groups a list of questions and are waiting for their confirmation.

**TIFF import and viewing.** Users can open a .tif or .tiff file and see its dimensions, bands, data type and coordinate system. The image is fitted to the window and can be zoomed (pixels get bigger, without blurring), panned, and shown in true colour, false colour (NIR) or any band combination. Unsupported or damaged files show a clear message. To check that a click identifies the correct original pixel, our sample image stores row × 100 + col in the Blue band of its top-left corner. Automated browser tests clicked pixels both in the fitted view and after zooming in 10 notches, and each time the correct pixel was returned. While testing we found two bugs. A message banner appearing or disappearing shifted the image under the cursor, which could cause a wrong pixel to be labeled, so we made the banner float above the image. Switching display bands sometimes left the image blank. Both are fixed.

**Classes and point labeling.** The class panel lets users create classes with a name and colour, select one (or press 1–9), hide or show a class, and see how many points each has. Clicking the image creates a labeled point in the class colour. The selected point's class, row/column, pixel ID, map coordinates and original band values are displayed. A mistaken point can be removed, and Undo (Ctrl+Z) reverses the last labeling action, including a removal. Projects are saved, so work continues after closing the application. We wrote 14 automated backend tests for these features.

For the next sprint, we will update the shared records based on the feedback from Model and Verification. We will also add polygon labeling (densified into pixels), redo, and a minimap / magnifier for large images. We will review incoming correction requests in the interface and package the services with Docker once the other groups have runnable services.

Opening Task board:

| To-do | Doing | Done |
|---|---|---|
| Select the platform and set up the project | | Complete paper prototypes for the training tool |
| Agree on the data exchanged between groups | | Discuss making the platform web-based |
| Build basic TIFF import and viewing | | Split responsibilities (GUI frontend, backend, label processing) |
| Implement classes and point labeling | | |
| Set up the coding environment (VS Code, GitHub) | | |

Closing Task board:

| To-do | Doing | Done |
|---|---|---|
| Polygon / line labeling + densification | Waiting for Model & Verification feedback on the shared records | Compare platforms against requirements; choose React + Flask |
| Redo; magnifier / minimap | | Image-loading experiment (rasterio, tifffile, Pillow, geotiff.js) |
| Show and act on correction requests in the UI | | Shared repository with install and run instructions |
| Docker compose with the other groups' services | | Example training example and correction request records + JSON Schemas |
| Tiling for very large images | | TIFF import, band display, zoom/pan, unsupported-file messages |
| | | Pixel accuracy check |
| | | Class panel, point labeling, remove point, undo |
| | | Flowcharts (system, user flow, import sequence, correction loop, architecture) |
