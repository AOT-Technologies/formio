# Form Management Platform

![Formio](https://img.shields.io/badge/formio-2.4.1-blue) ![Formsflow-forms](https://img.shields.io/docker/v/formsflow/forms-flow-forms?label=formsflow-forms-latest-image)

**formsflow.ai** leverages form.io to build "serverless" data management applications using a simple drag-and-drop form builder interface.

To know more about form.io, go to  <https://form.io>.

# A combined form and API platform for Serverless applications

Form.io is a revolutionary combined Form and API platform for Serverless applications. This repository serves as the core Form and API engine for https://form.io. This system allows you to build "serverless" data management applications using a simple drag-and-drop form builder interface. These forms can then easily be embedded within your Angular.js and React applications using the
`<formio>` HTML element.

## Walkthrough video and tutorial

For a walkthrough tutorial on how to use this Open Source platform to build a Serverless application, watch the video [0 to M.E.A.N in 30 minutes](https://www.youtube.com/watch?v=d2gTYkPFhPI)

## Form Building & Rendering Demo

Here is a link to a demo of the Form Building and Form Rendering capability that can be hooked into this API platform.

 
## Prerequisites

* For docker based installation [Docker](https://docker.com) need to be installed.

## Solution Setup

 
### Installation

* Make sure you have a Docker machine up and running.
* Make sure your current working directory is "formio"
* Rename the file [sample.env](./sample.env) to **.env**.
* Modify the environment variables in the newly created **.env** file if needed. Environment variables are given in the table below,
* **NOTE : `{your-ip-address}` given inside the .env file should be changed to your host system IP address. Please take special care to identify the correct IP address if your system has multiple network cards**

> :information_source: Variables with trailing :triangular_flag_on_post: in below table should be updated in the .env file

|Variable name | Meaning | Possible values | Default value |
|--- | --- | --- | ---
|`FORMIO_DB_USERNAME`|Mongo Root Username. Used on installation to create the database.Choose your own||`admin`
|`FORMIO_DB_PASSWORD`|Mongo Root Password||`changeme`
|`FORMIO_DB_NAME`|Mongo Database  Name. Used on installation to create the database.Choose your own||`formio`
|`FORMIO_ROOT_EMAIL`|forms-flow-forms admin login|eg. admin@example.com|`admin@example.com`
|`FORMIO_ROOT_PASSWORD`|forms-flow-forms admin password|eg.changeme|`changeme`
|`NO_INSTALL`|To setup FORMIO client ui |1 / 0|`1`
|`MULTI_TENANCY_ENABLED`|To enable multit tenancy |true / false|`false`
|`FORMIO_DEFAULT_PROJECT_URL`:triangular_flag_on_post:|forms-flow-forms default url||`http://{your-ip-address}:3001`
|`FORMIO_JWT_SECRET`|forms-flow-forms jwt secret| |`--- change me now ---`|
|`FORMIO_JWT_EXPIRE`|forms-flow-forms jwt expire time| |`240`|

**Additionally, you may want to change these**

* The value of Mongo database details (especially if this instance is not just for testing purposes)
* The value of ROOT user account details (especially if this instance is not just for testing purposes)
  
### Running the application

* forms-flow-forms service uses port 3001, make sure the port is available.
* `cd {Your Directory}/formio`
* Run `docker-compose up -d` to start.


*NOTE: Use --build command with the start command to reflect any future **.env** changes eg : `docker-compose up --build -d`*

#### To stop the application

* Run `docker-compose stop` to stop.

### Health Check

   The application should be up and available for use at port defaulted to 3001 in  (i.e. <http://localhost:3001/>)

        Default Login Credentials
        -----------------
        User Name / Email : admin@example.com
        Password  : changeme

## Run with Docker Compose

The fastest way to run this library locally is to use [Docker](https://docker.com).

- [Install Docker](https://docs.docker.com/engine/install/)
- Download and unzip this package to a local directory on your machine.
- Open up your terminal and navigate to the unzipped folder of this library.
- Type the following in your terminal

  ```
  docker-compose up -d
  ```

  Or, if you have an older version of the Docker image on your machine

  ```bash
  docker-compose up -d --build
  ```

- Go to the following URL in your browser.
  ```
  http://localhost:3001
  ```
- Use the following credentials to login.
  - **email**: admin@example.com
  - **password**: CHANGEME
- To change the admin password.
  - Once you login, click on the **Admin** resource
  - Click **View Data**
  - Click on the **admin@example.com** row
  - Click **Edit Submission**
  - Set the password field
  - Click **Save Submission**
  - Logout

- Have fun!

## Manual Installation (Node + MongoDB)

To get started you will first need the following installed on your machine.

- Node.js - https://nodejs.org/en/
- MongoDB - http://docs.mongodb.org/manual/installation/
  - On Mac I recommend using Homebrew `brew install mongodb-community`
  - On Windows, download and install the MSI package @ https://www.mongodb.org/downloads
- You must then make sure you have MongoDB running by typing `mongod` in your terminal.

## Running with Node.js

You can then download this repository, navigate to the folder in your Terminal, and then type the following.

```bash
# install dependencies
yarn
# build the client application
yarn build
# start the server
yarn start
```

This will walk you through the installation process. When it is done, you will have a running Form.io management
application running at the following address in your browser.

## Custom Components

**formsflow.ai** has custom components supported which are created by extending the
base components within forms-flow-forms and then registering them within the core renderer.

Custom componets available in **formsflow.ai** are:

|Component Name | About | How to use |
|--- | --- | --- |
|**Text Area with Analytics** | To enable Text fields for sentiment analysis processing | [link](./custom-components/text-area-with-analytics/README.md)|

If you are interested in adding custom components for your use case in **formsflow.ai** we highly
recommend you to take a look at [Custom Component Docs](https://formio.github.io/formio.js/app/examples/customcomponent.html)
to understand how  Form.io renderer allows for the creation of Custom components.
You can also take a look at [formio.contrib](https://github.com/formio/contrib)
to look for examples and even contribute the custom components you create.

## Adding new indexes

You can add new indexes in Mongodb shell, according to your requirement. You can create indexes like below example:

```
db.submissions.createIndex({
    "data.applicationStatus ": 1
})
```

In this example:

* `submissions` is the collection name.
* `data.applicationStatus` is the fields which are to be added in index.

## Development

To start server with auto restart capability for development simply run this command:

```
npm run start:dev
```

## Deploy to Hosted Form.io

If you wish to deploy all of your forms and resources into the Form.io Hosted platform @ https://portal.form.io, you can do this by using the Form.io CLI command line tool.

```
npm install -g formio-cli
```

Once you have this tool installed, you will need to follow these steps.

- Create a new project within Form.io
- Create an API Key within this project by going to the **Project Settings | Stage Settings | API Keys**
- Next, you can execute the following command to deploy your local project into Hosted Form.io.

```
formio deploy http://localhost:3001 https://{PROJECTNAME}.form.io --dst-key={APIKEY}
```

You will need to make sure you replace `{PROJECTNAME}` and `{APIKEY}` with your new Hosted Form.io project name (found in the API url), as well as the API key that was created in the second step above.

This will then ask you to log into the local Form.io server (which can be provided within the Admin resource), and then after it authenticates, it will export the project and deploy that project to the Form.io hosted form.

## License Change (March 8th, 2020)

This library is now licensed under the OSL-v3 license, which is a copy-left OSI approved license. Please read the license @ https://opensource.org/licenses/OSL-3.0 for more information. Our goal for the change to OSLv3 from BSD is to ensure that appropriate Attribution is provided when creating proprietary products that leverage or extend this library.

## Help

We will be updating the help guides found @ https://help.form.io as questions arise and also to help you get started with Form.io.

Thanks for using Form.io!

The Form.io Team.

## LICENSE

We have build formsflow.ai form management platform leveraging [formio](https://github.com/formio/formio).
We use the OSL-v3 license similar to formio to ensure appropriate attribution is
provided to form.io. Please read the [license](./LICENSE.txt) for more information.

# Security

If you find and/or think you have found a Security issue, please quietly disclose it to security@form.io, and give us
sufficient time to patch the issue before disclosing it publicly.
