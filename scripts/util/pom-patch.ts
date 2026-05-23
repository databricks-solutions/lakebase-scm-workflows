// Inject Lakebase-specific Maven dependencies and plugins into an
// Initializr-generated pom.xml. Ported verbatim from src/utils/pomPatch.ts.

import * as fs from "node:fs";

const FLYWAY_PG_DEPENDENCY = `
        <dependency>
            <groupId>org.flywaydb</groupId>
            <artifactId>flyway-database-postgresql</artifactId>
        </dependency>`;

const LAKEBASE_PLUGINS = `
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <configuration>
                    <argLine>--enable-native-access=ALL-UNNAMED -XX:+EnableDynamicAgentLoading</argLine>
                </configuration>
            </plugin>
            <plugin>
                <groupId>org.flywaydb</groupId>
                <artifactId>flyway-maven-plugin</artifactId>
                <configuration>
                    <url>\${env.SPRING_DATASOURCE_URL}</url>
                    <user>\${env.SPRING_DATASOURCE_USERNAME}</user>
                    <password>\${env.SPRING_DATASOURCE_PASSWORD}</password>
                    <baselineOnMigrate>true</baselineOnMigrate>
                </configuration>
            </plugin>`;

export function patchPomForLakebase(pomPath: string): void {
  if (!fs.existsSync(pomPath)) {
    throw new Error(`pom.xml not found at ${pomPath}`);
  }

  let pom = fs.readFileSync(pomPath, "utf-8");

  if (!pom.includes("flyway-database-postgresql")) {
    pom = pom.replace("</dependencies>", `${FLYWAY_PG_DEPENDENCY}\n    </dependencies>`);
  }

  if (!pom.includes("flyway-maven-plugin")) {
    if (pom.includes("<artifactId>spring-boot-maven-plugin</artifactId>")) {
      pom = pom.replace(
        /(<plugin>\s*<groupId>org\.springframework\.boot<\/groupId>\s*<artifactId>spring-boot-maven-plugin<\/artifactId>\s*<\/plugin>)/,
        `$1${LAKEBASE_PLUGINS}`
      );
    } else if (pom.includes("</plugins>")) {
      pom = pom.replace("</plugins>", `${LAKEBASE_PLUGINS}\n        </plugins>`);
    }
  } else if (!pom.includes("maven-surefire-plugin")) {
    pom = pom.replace(
      "</plugins>",
      `
            <plugin>
                <groupId>org.apache.maven.plugins</groupId>
                <artifactId>maven-surefire-plugin</artifactId>
                <configuration>
                    <argLine>--enable-native-access=ALL-UNNAMED -XX:+EnableDynamicAgentLoading</argLine>
                </configuration>
            </plugin>
        </plugins>`
    );
  }

  fs.writeFileSync(pomPath, pom);
}
