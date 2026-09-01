GUI for LeRobot arm control

Multiple panels: configure, teleoperate, replay, infer.
A settings window.

1. Configure

Show view of robot arm and leader arm structure with motor indicators.
Select port from dropdown to view information.
Select type of device: robot/teleop
Select model: SO100/SO101
Display motor ids, current position, limits.
Select motor to view and edit fields. Do not allow setting ID to one that is already taken.
Press button to start calibration function. Specify file path where to save.

2. Teleoperate

Select setup: single leader-robot, dual leader-robot.
Select leader type, select robot type.
Select leader port, select robot port.
Select calibration file location for each.
Select extra options: record (name, path), display dashboard, use cameras (select camera for each)

3. Replay

Select device to replay on (type, model, port)
Select file to replay (path).
Start, stop, pause buttons

4. Infer

Select device to use (type, model, port)
Select cameras (port)
Select policy/model (path).
Start, stop, pause buttons.

Settings panel

Select path for lerobot installation if already installed.
Possibility to install if not already installed.
Select python version.
Config python venv (create, install dependencies, view installed modules)