// Deamon que es atacado por el cliente para recibir las peticiones de
// creación-destrucción de contenedores, y que se coordina con el resto de
// nodos del cluster por medio del servidor, que gestiona la base de datos "etcd"

const zmq = require('zeromq');
const { exec, spawn } = require('child_process');
const { existsSync } = require('fs');
const { mkdir } = require('fs/promises');
const { resolve } = require('path');


class Deamon{
    constructor(miNombre, miIP, servidorIP, LAN, puertoServicio, puertoReq, puertoSub){
        // Variables que conserva el Deamon
        this.miNombre = miNombre;
        this.miIP = miIP;
        this.servidorIP = servidorIP;
        this.LAN = LAN;
        this.puertoServicio = puertoServicio;
        this.puertoReq = puertoReq;
        this.puertoSub = puertoSub;

        this.misContenedores = [];
        this.subred = '';

        //sockets para servir al cliente y para conectarse al servidor

        //socket servicio
        this.socketServicio = zmq.socket('rep');
        this.socketServicio.bindSync(`tcp://*:${puertoServicio}`);
        console.log(`Sirviendo al cliente en el puerto ${puertoServicio}`);

        this.socketServicio.on('message', (metodo,argumentos) => {
            try{
                // Este truco con 0MQ ya permite tener un proxy universal
                metodo = metodo.toString();
                argumentos = argumentos.toString().split(',');

                console.log(`Peticion del cliente -> metodo: ${metodo}, argumentos: ${argumentos}`);
                // Llama al método correspondiente y le pasa los argumentos
                // como un array de strings
                this[metodo](...argumentos);

            } catch (err){
                console.log(err);
            }
        });


        // socket cliente del servidor
        this.socketReq = zmq.socket('req');
        this.socketReq.connect(`tcp://${this.servidorIP}:${puertoReq}`);

        // Estas son las respuestas del servidor
        // Tienen que ser redirijidas a los métodos correspondientes para hacer el setup
        // this.socketReq.on('message', (metodo,respuesta) => {
        //     metodo = metodo.toString();

        //     respuesta = respuesta.toString();
            
        //     console.log(`Respuesta del servidor -> metodo: ${metodo}, respuesta: ${respuesta}`);
        //     this[metodo](respuesta)
        // });


        // socket subscriptor
        this.socketSub = zmq.socket('sub');
        this.socketSub.connect(`tcp://${servidorIP}:${puertoSub}`);
        this.socketSub.subscribe('deamon');

    }

    // Promesa que devuelve las respuestas del servidor
    respuestaServidor(){
        return new Promise((resolve) => {
            this.socketReq.on('message', (respuesta) => {
                resolve(respuesta.toString());
            });
        })
    }

    // Método para darme de alta en el servidor
    async darmeDeAlta(miNombre, miIP){

        console.log("Dandome de alta en el clúster, esperando respuesta...");
        this.registrameEnElCluster(miNombre,miIP);

        let respuesta = await this.respuestaServidor();
        console.log(`Respuesta del servidor: ${respuesta}`);

        if (respuesta !== 'dentro'){
            this.socketReq.close();
            this.socketServicio.close();
            this.socketSub.close();
            process.exit(1);
        }

    }

    async dameInfoSistema(){
        console.log(`Pidiendo información del clúster al servidor`);
        this.infoSistema();
        let respuesta = await this.respuestaServidor();

        // Respondemos al cliente con toda la info
        this.socketServicio.send(respuesta);
    }

    // Configurar el nodo
    async configurameElNodo(subred){
        this.subred = subred;
        console.log(`subred recibida: ${this.subred}`);

        try{
            // Construir la imagen de los contenedores sin red
            console.log("Generando imagen Docker: ubuntu_overlay");
            // let [stdout, stderr] = await this.comandoBash(`sudo docker build -t ubuntu_overlay .`)
            // console.log(stdout);

            

            console.log("Cambiando politica de la cadena de FORWARD a ACCEPT");
            //let [stdout, stderr] = await this.comandoBash(`sudo iptables -P FORWARD ACCEPT`);

            console.log("Comprobando si existe directorio: /run/netns/");
            if (existsSync('/run/netns')){
                console.log("Existe el directorio: /run/netns");
            } else{
                console.log("No existe el directorio: /run/netns");
                //await mkdir('/run/netns/');
            }

            // Aplicar reglas de Source NAT para la subred seleccionada

            // Listar todas las reglas de nat
            let [stdout, stderr] = await this.comandoBash(`sudo iptables -t nat -S`);

            // Separar las reglas por filas y buscar el match
            let match = stdout.split('\n').find(line => line === `-A POSTROUTING -s ${subred} -j MASQUERADE`);
            // Si match es indefinido se pone regla, sino nada
            if (typeof(match) === 'undefined'){
                console.log("Poniendo regla de NAT en iptables");
                //[stdout, stderr] = await this.comandoBash(`sudo iptables -t nat -A POSTROUTING -s ${subred} -j MASQUERADE`)
            }


            // Levantar interfaces
            console.log("Levantando interfaces bridge and VxLAN");
            // let [stdout, stderr] = await this.comandoBash(`sudo ip link add br0 type bridge`);


            console.log("Pidiendo una direccion IP para el bridge al servidor, esperando respuesta...");
            this.dameBridgeIP(this.subred, this.miNombre);

            let bridgeIP = await this.respuestaServidor();
            console.log(`IP devuelta del servidor: ${bridgeIP}`);

            // Poner la IP al bridge
            console.log(`Asignando la IP ${bridgeIP} al br0`);
            //let [stdout, stderr] = await this.comandoBash(`sudo ip a add ${bridgeIP} dev br0`)

            // Respondemos al cliente que todo bien
            this.socketServicio.send('Nodo configurado, listo para el servicio!!')

        } catch (err) {
            console.log(err);
        }
    }


    comandoBash(comando){
        return new Promise((resolve,reject) => {
            exec(comando, (err,stdout,stderr) => {
                if (err){
                    reject(err);
                } else{
                    resolve([stdout,stderr]);
                }
            });
        })
    }


    levantaContenedor(){
        return
    }

    prueba(mensaje){
        console.log(`Estoy en el metodo de prueba del deamon, he recibido: ${mensaje}`);
    }


    // Proxy del servidor

    // En los proxys mandamos como primer elemento del array el método
    // y el resto son los argumentos

    dameBridgeIP(subred,miNombre){
        const metodo = 'dameBridgeIP';
        const argumentos = subred + ',' + miNombre;
        this.socketReq.send([metodo, argumentos]);
    }

    registrameEnElCluster(nombreNodo, nodoIP){
        const metodo = 'registrameEnElCluster';
        const argumentos = nombreNodo + ',' + nodoIP;
        this.socketReq.send([metodo,argumentos]);
    }

    infoSistema(vacio){
        const metodo = 'infoSistema';
        const argumentos = '';
        this.socketReq.send([metodo, argumentos]);
    }

    hayQueLevantarOtro(){
        return
    }
}


const main = () => {
    const miNombre = process.argv[2] || 'Zeus';
    const miIP = process.argv[3] || 'localhost';
    const servidorIP = process.argv[4] || 'localhost';
    const LAN = process.argv[5] || '192.168.1.0/24';
    const puertoServicio = process.argv[6] || 5002;
    const puertoReq = process.argv[7] || 8081;
    const puertoSub = process.argv[8] || 8080;

    const deamon = new Deamon(
                            miNombre,
                            miIP,
                            servidorIP,
                            LAN,
                            puertoServicio,
                            puertoReq,
                            puertoSub);
                        
    
    deamon.darmeDeAlta(deamon.miNombre, deamon.miIP);


    // Para matar el programa
    process.on('SIGINT', () => {
        console.log("Cerrando servicio y matando deamon");
        deamon.socketServicio.close();
        deamon.socketReq.close();
        deamon.socketSub.close();
    });

}

main();